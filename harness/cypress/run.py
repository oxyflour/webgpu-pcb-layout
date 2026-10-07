"""Run an installed Cypress on the exported experiment; verify pin coordinates first.

Harness copy of webgpu-layout-code bench/cypress/run.py. Additions:
- run with cwd = job dir so concurrent jobs keep separate DREAMPlace.log files;
- optional hints.json: {"init_choice": {node: k}, "net_weights": {net: w}} to warm-start
  movable orientations (Cypress orientation index k, quarter turns CCW in y-up) and to
  weight nets in the wirelength/crossing objective.
"""
import json, sys, time, os, logging, shutil, ctypes
THREADS=int(os.environ.get('CYPRESS_THREADS','8'))
os.environ['OMP_NUM_THREADS']=str(THREADS)
os.environ['MKL_NUM_THREADS']=str(THREADS)
import numpy as np
import torch
torch.set_num_threads(THREADS)
torch.set_num_interop_threads(1)
# Upstream's detailed-placement extension references cuRAND without linking it.
ctypes.CDLL('/usr/local/cuda/lib64/libcurand.so', mode=ctypes.RTLD_GLOBAL)
sys.path.insert(0, '/Cypress/install')
from dreamplace.Placer import PlacementEngine

job = os.path.abspath(sys.argv[1])
with open(os.path.join(job, 'bridge.json')) as f: bridge = json.load(f)
units = bridge['units']
with open(os.path.join(job, 'config.json')) as f: config = json.load(f)
config['aux_input'] = os.path.join(job, 'board.aux')
config['result_dir'] = os.path.join(job, 'results')
config['plot_flag'] = 0
config['get_congestion_map'] = 0
start = time.perf_counter()
engine = PlacementEngine(config)
engine.setup_rawdb()
db = engine.placedb
db.initialize_from_rawdb(engine.params)
decode = lambda x: x.decode() if isinstance(x, bytes) else str(x)
node_names = [decode(x) for x in db.node_names]
net_names = [decode(x) for x in db.net_names]
by_name = {e['name']: e for e in bridge['entries']}
parser_pin_count=len(db.pin2node_map)
parser_bottom_count=int((db.node_side_flag==0).sum())
# The legacy IC Bookshelf parser merges equal node/net pins. Rebuild Python
# placement geometry and assigned sides from the complete PCB
# bridge before initializing the solver; keep its native node ordering and rows.
node_index={name:i for i,name in enumerate(node_names)}
net_index={name:i for i,name in enumerate(net_names)}
for i,name in enumerate(node_names):
    e=by_name[name]
    db.node_x[i]=round((e['x']-e['width']/2)*units)
    db.node_y[i]=round((e['y']-e['height']/2)*units)
    db.node_size_x[i]=round(e['width']*units)
    db.node_size_y[i]=round(e['height']*units)
db.node_orient=np.array([b'FN' if by_name[name]['side'] else b'N' for name in node_names])
db.node_side_flag=np.array([1-by_name[name]['side'] for name in node_names],dtype=np.int32)
pins=bridge['expectedPins']
db.pin2node_map=np.array([node_index[pin['node']] for pin in pins],dtype=np.int32)
db.pin2net_map=np.array([net_index[pin['net']] for pin in pins],dtype=np.int32)
db.pin_offset_x=np.array([pin['x']*units-db.node_x[node_index[pin['node']]] for pin in pins],dtype=db.dtype)
db.pin_offset_y=np.array([pin['y']*units-db.node_y[node_index[pin['node']]] for pin in pins],dtype=db.dtype)
db.pin_direct=np.full(len(pins),b'I')
def maps(owner,count):
    groups=[np.where(owner==i)[0].astype(np.int32) for i in range(count)]
    flat=np.concatenate(groups).astype(np.int32)
    starts=np.array([0]+list(np.cumsum([len(g) for g in groups])),dtype=np.int32)
    return groups,flat,starts
db.node2pin_map,db.flat_node2pin_map,db.flat_node2pin_start_map=maps(db.pin2node_map,db.num_physical_nodes)
db.net2pin_map,db.flat_net2pin_map,db.flat_net2pin_start_map=maps(db.pin2net_map,len(net_names))
db.initialize(engine.params)
hints_file = os.path.join(job, 'hints.json')
hints = json.load(open(hints_file)) if os.path.exists(hints_file) else {}
init_choice = np.zeros(db.orient_logits.shape[0], dtype=np.int64)
for name, k in hints.get('init_choice', {}).items():
    i = node_index[name]
    if k:
        # Swap the dominant default logit to the requested orientation.
        db.orient_logits[i, [0, k]] = db.orient_logits[i, [k, 0]]
        init_choice[i] = k
for name, w in hints.get('net_weights', {}).items():
    db.net_weights[net_index[name]] = float(w)
import dreamplace.BasicPlace as _bp
_init = _bp.PlaceDataCollection.__init__
def _patched(self, pos, orient_logits, params, placedb, device):
    _init(self, pos, orient_logits, params, placedb, device)
    with torch.no_grad():
        c = torch.from_numpy(init_choice).to(device)
        self.best_orient_choice.copy_(c.to(self.best_orient_choice.dtype))
        self.best_theta.copy_(c.to(self.best_theta.dtype) * np.pi / 2)
_bp.PlaceDataCollection.__init__ = _patched
# Each iteration also evaluated the crossing count just for its log line (acc: ~195 ms of
# ~200 ms per iteration). Skip it; the final summary reads metric.net_crossing, so store 0.
import dreamplace.EvalMetrics as _em
_eval = _em.EvalMetrics.evaluate
def _evaluate(self, placedb, ops, *a, **k):
    r = _eval(self, placedb, {n: f for n, f in ops.items() if n != 'net_crossing'}, *a, **k)
    if 'net_crossing' in ops: self.net_crossing = torch.zeros(())
    return r
_em.EvalMetrics.evaluate = _evaluate
if not config.get('net_crossing_flag', 1):
    # Upstream's rotation step needs model.net_crossing (only built with the crossing term)
    # and accepts a sampled rotation only if wirelength AND crossing improve. Without the
    # term, report an ever-larger crossing so no sample is accepted: orientations stay as
    # warm-started. (Accepting on wirelength alone wrecked warm starts: k60 human 318 -> 265.)
    import dreamplace.PlaceObj as _po
    class _Increasing:
        def __init__(self): self.v = 0.0
        @property
        def data(self): self.v += 1.0; return self.v
    _po.PlaceObj.net_crossing = _Increasing()

# Check the complete reconstructed pin geometry before solver initialization.
actual = {}
for i, ci in enumerate(db.pin2node_map):
    key = (node_names[int(ci)], net_names[int(db.pin2net_map[i])])
    actual.setdefault(key, []).append((float(db.node_x[ci]+db.pin_offset_x[i])/units,
                                       float(db.node_y[ci]+db.pin_offset_y[i])/units))
pin_error = 0.0
for pin in bridge['expectedPins']:
    points = actual[(pin['node'], pin['net'])]
    nearest = min(range(len(points)), key=lambda i: abs(points[i][0]-pin['x'])+abs(points[i][1]-pin['y']))
    x, y = points.pop(nearest)
    pin_error = max(pin_error, abs(x-pin['x']), abs(y-pin['y']))
if pin_error > 0.011:
    raise RuntimeError(f'Bookshelf pin coordinate mismatch: {pin_error} mm')

# Fixed geometry is baked at orientation zero; restricted parts must never be
# randomly rotated by Gumbel sampling, even though their gradients are masked.
for i, name in enumerate(node_names[:db.num_physical_nodes]):
    if by_name[name]['fixed'] or not by_name[name]['rotatable']:
        db.orient_logits[i,:] = -1e9
        db.orient_logits[i,0] = 0
setup_seconds = time.perf_counter()-start
solve_start = time.perf_counter()
engine.place()
torch.cuda.synchronize()
solve_seconds = time.perf_counter()-solve_start
pos = engine.placer.pos[0].detach().cpu().numpy()
choices = engine.placer.data_collections.best_orient_choice.detach().cpu().numpy()
sizes_x = engine.placer.data_collections.node_size_x.detach().cpu().numpy()
sizes_y = engine.placer.data_collections.node_size_y.detach().cpu().numpy()
placements = []
for i, name in enumerate(node_names[:db.num_physical_nodes]):
    e = by_name[name]
    if e.get('obstacle'): continue
    # Cypress's pin-position kernel rotates about the original rectangle centre.
    # Use the solver's final rectangles: it removes macro halos on the GPU
    # after optimization, while the Python database still has padded sizes.
    x = (float(pos[i]) + float(sizes_x[i])/2)/units
    y = bridge['height'] - (float(pos[db.num_nodes+i]) + float(sizes_y[i])/2)/units
    # y-up counterclockwise becomes a negative quarter turn in y-down IR.
    r = (-int(choices[i])) % 4
    if e['fixed']: x, y, r = e['x'], bridge['height']-e['y'], e['rotation']
    placements.append({'id': e['id'], 'x':x,'y':y,'rotation':r,'side':e['side']})
engine.placer.op_collections.pin_pos_op.use_best_theta = True
with torch.no_grad():
    final_pins = engine.placer.op_collections.pin_pos_op(engine.placer.pos[0]).cpu().numpy()
pin_count = len(db.pin2node_map)
engine_pins = [{'id':by_name[node_names[int(ci)]]['id'], 'net':net_names[int(db.pin2net_map[i])],
                'x':float(final_pins[i])/units,
                'y':bridge['height']-float(final_pins[pin_count+i])/units}
               for i,ci in enumerate(db.pin2node_map)]
result = {'placements':placements,'setup_s':setup_seconds,'solve_s':solve_seconds,
          'engine_pins':engine_pins,
          'total_s':time.perf_counter()-start,'pin_roundtrip_max_error_mm':pin_error,
          'engine_hpwl':engine.hpwl if np.isfinite(engine.hpwl) else None,
          'engine_rsmt':engine.rsmt if np.isfinite(engine.rsmt) else None,
          'engine_converged':bool(np.isfinite(engine.hpwl)),
          'iterations':len(engine.metrics.get('objective',[])),
          'final_overflow':engine.metrics.get('overflow',[None])[-1],
          'parser_pin_count':parser_pin_count,'input_pin_count':len(pins),
          'parser_bottom_nodes':parser_bottom_count,
          'config':config,'torch':torch.__version__,'cuda':torch.version.cuda}
with open(os.path.join(job,'engine-metrics.json'),'w') as f: json.dump(engine.metrics,f)
logging.shutdown()
shutil.copyfile('DREAMPlace.log',os.path.join(job,'engine.log'))
with open(os.path.join(job,'output.json'),'w') as f: json.dump(result,f,indent=2)
print(json.dumps({k:v for k,v in result.items() if k not in ('placements','config','engine_pins')}))

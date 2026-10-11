# Draws the frames exported by trajectory-gif.mjs into an animated GIF (Pillow).
# python trajectory_gif.py frames.json out.gif
import json, sys, textwrap
from PIL import Image, ImageDraw, ImageFont

D = json.load(open(sys.argv[1], encoding='utf8'))
W, H = D['W'], D['H']
PANEL = 560                       # board panel width (px)
sc = PANEL / W
ph = int(H * sc)
M = 16                            # margin
TOP = 92                          # header height
CH = 130                          # chart height
TXT = 64                          # agent message height
IW, IH = 2 * PANEL + 3 * M, TOP + ph + CH + TXT + 3 * M

def font(size, bold=False):
    for f in (['arialbd.ttf', 'DejaVuSans-Bold.ttf'] if bold else ['arial.ttf', 'DejaVuSans.ttf']):
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()
F1, F2, F3 = font(20, True), font(15), font(13)

BG, INK, MUTED, GRID = (250, 250, 248), (30, 30, 30), (110, 110, 110), (225, 225, 220)
FIXED, SMALL, MOVED, BEST, HUMAN = (120, 120, 120), (175, 180, 190), (220, 40, 40), (30, 140, 70), (60, 90, 200)
PALETTE = [(31, 119, 180), (255, 127, 14), (44, 160, 44), (148, 103, 189), (140, 86, 75), (227, 119, 194), (23, 190, 207), (188, 189, 34), (214, 39, 40), (127, 127, 127)]
parts = D['parts']
bigs = [i for i, p in enumerate(parts) if p['big'] and not p['fixed']]
colour = {i: PALETTE[k % len(PALETTE)] for k, i in enumerate(sorted(bigs, key=lambda i: -parts[i]['w'] * parts[i]['h']))}

def rect(i, q, ox, oy):
    x, y, rot, side = q
    w, h = parts[i]['size']
    if rot % 2: w, h = h, w
    return [ox + (x - w / 2) * sc, oy + (y - h / 2) * sc, ox + (x + w / 2) * sc, oy + (y + h / 2) * sc]

def board(d, L, ox, oy, moved=()):
    d.rectangle([ox, oy, ox + W * sc, oy + H * sc], fill=(255, 255, 255), outline=(60, 60, 60), width=2)
    order = sorted(range(len(parts)), key=lambda i: (parts[i]['big'], parts[i]['fixed']))
    for i in order:
        r = rect(i, L[i], ox, oy)
        bottom = L[i][3] == 1
        if parts[i]['fixed']: fill = FIXED
        elif parts[i]['big']: fill = colour[i]
        else: fill = SMALL
        if bottom: fill = tuple(int(c * 0.45 + 255 * 0.55) for c in fill)   # bottom side: paler
        d.rectangle(r, fill=fill, outline=(70, 70, 70) if parts[i]['big'] else None)
        if parts[i]['big'] and not parts[i]['fixed'] and r[2] - r[0] > 26:
            d.text(((r[0] + r[2]) / 2, (r[1] + r[3]) / 2), parts[i]['ref'], fill=(255, 255, 255), font=F3, anchor='mm')
    for i in moved:
        d.rectangle([v + o for v, o in zip(rect(i, L[i], ox, oy), (-3, -3, 3, 3))], outline=MOVED, width=3)

frames = D['frames']
vias = [f['metrics']['vias'] for f in frames]
hv = D['human'].get('vias')
# Vias axis: from below the lowest value to 1.4x the median (outliers such as an unrouted baseline are clipped, marked ↑).
med = sorted(vias)[len(vias) // 2]
lo = 0.9 * min(vias + ([hv] if hv else [])); hi = max(min(max(vias), 1.4 * med), (hv or 0) * 1.05)
rank = lambda f: (f['metrics']['clean'], -f['metrics']['vias'])

def draw(k, final=False):
    f = frames[k]
    im = Image.new('RGB', (IW, IH), BG); d = ImageDraw.Draw(im)
    shown = len(frames) - 1 if final else k            # bars up to here; the final frame shows every candidate
    best = max(frames[:shown + 1], key=rank)
    head = f"{D['title']} — {'SUBMITTED ' if final else ''}{f['id']}" + (f" (from {f['from']})" if f['from'] and f['from'] != 'centroid' else '')
    d.text((M, M), head, fill=INK, font=F1)
    m = f['metrics']
    d.text((M, M + 30), f"clean nets {m['clean']}/{m['nets']}   vias {m['vias']}   HPWL {m['hpwlMm']:.0f} mm   ·   agent moved: " + (', '.join(parts[i]['ref'] for i in f['moved'][:8]) + (' …' if len(f['moved']) > 8 else '') if f['moved'] else 'nothing (same plan, other seed)' if f['from'] not in (None, 'centroid') else 'no plan'), fill=INK, font=F2)
    d.text((M, M + 52), f"best so far: {best['id']} — clean {best['metrics']['clean']}, vias {best['metrics']['vias']}" + (f"   ·   human: clean {D['human']['clean']}, vias {hv}" if hv else '') + ('   ·   ' + f['label'][:60] if f['label'] else ''), fill=MUTED, font=F2)
    y0 = TOP + M
    board(d, f['layout'], M, y0, f['moved'])
    board(d, D['human']['layout'], 2 * M + PANEL, y0)
    d.text((M + 4, y0 + 4), 'agent candidate (red: placed by the agent in this call; paler: bottom side)', fill=INK, font=F3)
    d.text((2 * M + PANEL + 4, y0 + 4), 'human layout', fill=INK, font=F3)
    # Vias per candidate.
    cy = y0 + ph + M; cw = IW - 2 * M - 70; bw = cw / len(frames)
    d.rectangle([M, cy, M + cw, cy + CH], fill=(255, 255, 255), outline=GRID)
    yv = lambda v: cy + CH - 14 - (min(v, hi) - lo) / max(1, hi - lo) * (CH - 34)
    if hv:
        d.line([M, yv(hv), M + cw, yv(hv)], fill=HUMAN, width=1)
        d.text((M + cw + 2, yv(hv)), f'human {hv}', fill=HUMAN, font=F3, anchor='lm')
    run = None
    for j, g in enumerate(frames):
        x = M + j * bw + bw / 2
        if j <= shown:
            col = INK if j == k else ((200, 200, 200) if g['metrics']['clean'] < g['metrics']['nets'] else (150, 150, 150))
            d.rectangle([x - bw * 0.3, yv(g['metrics']['vias']), x + bw * 0.3, cy + CH - 14], fill=col)
            d.text((x, yv(g['metrics']['vias']) - 2), str(g['metrics']['vias']) + ('↑' if g['metrics']['vias'] > hi else ''), fill=MUTED, font=F3, anchor='mb')
            run = g if run is None or rank(g) > rank(run) else run
            if j: d.line([x - bw, yv(prev), x, yv(run['metrics']['vias'])], fill=BEST, width=2)
            prev = run['metrics']['vias']
        d.text((x, cy + CH - 2), g['id'][1:], fill=MUTED, font=F3, anchor='mb')
    d.text((M + 4, cy - 1), 'vias per candidate (black: this frame; light grey: not all nets routed); green line: best so far', fill=MUTED, font=F3)
    # Agent message before the call.
    msg = f['said'] or ('tool baseline (no plan), made before the agent starts' if f['id'] == 'c000' else '')
    wrapped = textwrap.wrap(msg, 150)[:3]
    for j, line in enumerate(wrapped):
        d.text((M, cy + CH + M + j * 18), ('agent: ' if j == 0 else '       ') + line, fill=INK, font=F2)
    return im

ims = [draw(k) for k in range(len(frames))]
sub = next((k for k, f in enumerate(frames) if f['id'] == D.get('submitted')), None)
durs = [D['ms']] * len(ims)
if sub is not None:
    ims.append(draw(sub, final=True)); durs.append(4000)
ims = [im.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for im in ims]
ims[0].save(sys.argv[2], save_all=True, append_images=ims[1:], duration=durs, loop=0, optimize=True)
print(sys.argv[2], len(ims), 'frames')

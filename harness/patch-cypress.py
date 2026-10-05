"""Respect Cypress's existing crossing flag in evaluation and rotation selection.

Only the supplied isolated container is modified by the installer. CUDA kernels,
HPWL, density, Gumbel rotations and all input net/pin data remain upstream.
"""
from pathlib import Path
import hashlib
import json
import difflib

source = Path('/Cypress/install/dreamplace/NonLinearPlace.py')
before = source.read_text()
marker = '# cypress-harness-crossing-flag-v1'
if marker in before:
    crossing = {'alreadyApplied': True, 'sha256': hashlib.sha256(before.encode()).hexdigest()}
else:
    replacements = [
        ('                    "net_crossing": self.op_collections.net_crossing_op,\n', ''),
        ('                    "overflow": self.op_collections.two_side_density_overflow_op,\n                }\n                if params.routability_opt_flag:\n',
         '                    "overflow": self.op_collections.two_side_density_overflow_op,\n                }\n'
         '                ' + marker + '\n'
         '                if params.net_crossing_flag:\n'
         '                    eval_ops["net_crossing"] = self.op_collections.net_crossing_op\n'
         '                if params.routability_opt_flag:\n'),
        ('best_wl, best_nc = model.wirelength.data, model.net_crossing.data',
         'best_wl, best_nc = model.wirelength.data, (model.net_crossing.data if params.net_crossing_flag else 0)'),
        ('if model.wirelength.data < best_wl and model.net_crossing.data < best_nc:',
         'if model.wirelength.data < best_wl and (not params.net_crossing_flag or model.net_crossing.data < best_nc):'),
    ]
    expected = [1, 1, 2, 1]
    after = before
    for (old, new), count in zip(replacements, expected):
        if after.count(old) != count:
            raise RuntimeError(f'Unexpected Cypress source; replacement needs {count} matches: {old!r}')
        after = after.replace(old, new)
    compile(after, str(source), 'exec')
    source.with_suffix('.py.crossing-original').write_text(before)
    source.write_text(after)
    crossing = {'alreadyApplied': False, 'beforeSha256': hashlib.sha256(before.encode()).hexdigest(),
                      'sha256': hashlib.sha256(after.encode()).hexdigest(),
                      'diff': ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                                        fromfile='upstream/NonLinearPlace.py', tofile='patched/NonLinearPlace.py'))}

# FLUTE was compiled with MAXD=150. Only its post-solve diagnostic is capped;
# the placement HPWL/density/rotation objective keeps the full rail networks.
source = Path('/Cypress/install/dreamplace/BasicPlace.py')
before = source.read_text()
marker = '# cypress-harness-rsmt-degree-guard-v1'
if marker in before:
    rsmt = {'alreadyApplied': True, 'sha256': hashlib.sha256(before.encode()).hexdigest()}
else:
    start = before.index('    def build_rsmt_wl(')
    end = before.index('    def build_legality_check(', start)
    section = before[start:end]
    old = '            ignore_net_degree=params.ignore_net_degree,\n'
    if section.count(old) != 1:
        raise RuntimeError('Unexpected FLUTE diagnostic source')
    section = section.replace(old, '            ' + marker + '\n            ignore_net_degree=min(params.ignore_net_degree, 150),\n')
    after = before[:start] + section + before[end:]
    compile(after, str(source), 'exec')
    source.with_suffix('.py.rsmt-original').write_text(before)
    source.write_text(after)
    rsmt = {'alreadyApplied': False, 'beforeSha256': hashlib.sha256(before.encode()).hexdigest(),
            'sha256': hashlib.sha256(after.encode()).hexdigest(),
            'diff': ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                              fromfile='upstream/BasicPlace.py', tofile='patched/BasicPlace.py'))}
print(json.dumps({'crossing': crossing, 'rsmt': rsmt}))

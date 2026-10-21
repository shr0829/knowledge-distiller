"""Compare identical local queries; never print source bodies."""
import ctypes
import importlib.util
import json
import sys
import time
from pathlib import Path

from library_companion.retrieval import Retrieval
from library_companion.store import Store, now

sys.stdout.reconfigure(encoding='utf-8')

def counters():
    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

    result = IO()
    kernel = ctypes.windll.kernel32
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.GetProcessIoCounters.argtypes = [ctypes.c_void_p, ctypes.POINTER(IO)]
    if not kernel.GetProcessIoCounters(kernel.GetCurrentProcess(), ctypes.byref(result)):
        raise ctypes.WinError()
    return {name: getattr(result, name) for name in ('read_ops', 'read_bytes')}

def memory():
    class MEMORY(ctypes.Structure):
        _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong),
                    *[(key, ctypes.c_size_t) for key in ('PeakWorkingSetSize', 'WorkingSetSize',
                        'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                        'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]]
    result = MEMORY()
    result.cb = ctypes.sizeof(result)
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p,
                                                       ctypes.POINTER(MEMORY), ctypes.c_ulong]
    if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(),
                                                   ctypes.byref(result), result.cb):
        raise ctypes.WinError()
    return {'working_set_bytes': result.WorkingSetSize, 'process_peak_bytes': result.PeakWorkingSetSize}


store = Store()
retrieval = Retrieval(store)
mode = sys.argv[1]
if mode == 'before':
    for name in ('knowledge', 'retrieval'):
        spec = importlib.util.spec_from_file_location(
            'library_companion._baseline_' + name,
            Path('work/retrieval-optimization') / (name + '_before.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if name == 'knowledge':
            baseline_knowledge = module.Knowledge(store)
        else:
            retrieval = module.Retrieval(store)
            retrieval.knowledge = baseline_knowledge

questions = [
    ('BaoSteel', '物理约束'),
    ('BaoSteel', 'TSC 碳温监督'),
    ('天枢12345热线', '知识库检索'),
]
rows = []
for name, question in questions:
    project = next(p for p in store.projects() if p['name'] == name)
    for repeat in range(2):
        before, start = counters(), time.perf_counter()
        result = retrieval.search(question, [project['id']], 'raw', 'local', 8)
        end = counters()
        rows.append({'project': name, 'question': question, 'repeat': repeat,
                     'seconds': time.perf_counter() - start,
                     'read_bytes': end['read_bytes'] - before['read_bytes'],
                     'read_ops': end['read_ops'] - before['read_ops'],
                     'memory': memory(),
                     'hits': [h.get('source_id', h['id']) for h in result['hits']],
                     'warnings': result['warnings'], 'metrics': result.get('metrics')})
        print(json.dumps({k: v for k, v in rows[-1].items() if k != 'hits'},
                         ensure_ascii=False), flush=True)
Path('work/retrieval-optimization/' + mode + '.json').write_text(
    json.dumps({'verified_at': now(), 'mode': mode, 'results': rows}, ensure_ascii=False, indent=2),
    encoding='utf-8')

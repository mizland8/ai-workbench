#!/usr/bin/env python3
"""Collect license notices from the pinned Go module cache; no credentials or local paths are written."""
import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[1]
raw=subprocess.check_output(['go','list','-m','-json','all'],cwd=root,text=True);decoder=json.JSONDecoder();modules=[]
while raw.strip():
    item,end=decoder.raw_decode(raw.lstrip());modules.append(item);raw=raw.lstrip()[end:]
parts=['Third-party notices for Workbench embedded networking\n']
for module in modules:
    if module.get('Main') or not module.get('Dir'):continue
    directory=pathlib.Path(module['Dir']);files=[]
    for pattern in ('LICENSE*','COPYING*','NOTICE*'):files.extend(p for p in directory.glob(pattern) if p.is_file())
    if not files:continue
    parts.append('\n\n'+module['Path']+' '+module.get('Version','')+'\n'+'='*72+'\n')
    for file in sorted(set(files)):parts.append(file.name+'\n'+file.read_text(errors='replace')+'\n')
(root/'netcore/notices.txt').write_text(''.join(parts))
print('Collected notices for pinned networking dependencies.')

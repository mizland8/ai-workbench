#!/usr/bin/env python3
"""UI smoke test on an emulator only. Never clears phone data."""
import pathlib, re, subprocess, time, xml.etree.ElementTree as ET
ROOT=pathlib.Path(__file__).resolve().parents[1]
ADB=str(ROOT/'tools/sdk/platform-tools/adb')
def adb(*args): return subprocess.check_output([ADB,'-e',*args],text=True).strip()
def tree():
    adb('shell','uiautomator','dump','/sdcard/workbench-smoke.xml')
    return ET.fromstring(adb('exec-out','cat','/sdcard/workbench-smoke.xml'))
def tap(n):
    x1,y1,x2,y2=map(int,re.findall(r'\d+',n.attrib['bounds']))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
def click(label, suffix=False):
    nodes=[n for n in tree().iter('node') if (n.get('text','').endswith(label) if suffix else n.get('text','').casefold()==label.casefold())]
    assert nodes, 'Missing UI: '+label
    tap(nodes[0])
def fill(index,value):
    fields=[n for n in tree().iter('node') if n.get('class')=='android.widget.EditText']
    tap(fields[index]);adb('shell','input','keyevent','KEYCODE_MOVE_END')
    for _ in range(len(fields[index].get('text',''))):adb('shell','input','keyevent','KEYCODE_DEL')
    adb('shell','input','text',value.replace(' ','%s'))
def contains(value):return any(value in n.get('text','') for n in tree().iter('node'))
adb('shell','am','force-stop','com.aiworkbench.companion')
adb('shell','am','start','-W','-n','com.aiworkbench.companion/.MainActivity')
click('Computers',True);click('Edit computer');fill(0,'Studio PC');click('Save')
assert contains('Studio PC')
click('Projects',True);assert contains('No synced projects yet')
click('Write a draft');fill(1,'Claude');fill(2,'Review the project tests')
adb('shell','input','keyevent','KEYCODE_BACK');click('Save draft')
assert contains('Review the project tests')
assert contains('DRAFT')
adb('shell','am','force-stop','com.aiworkbench.companion')
adb('shell','am','start','-W','-n','com.aiworkbench.companion/.MainActivity')
click('Computers',True);assert contains('Studio PC')
click('Chats',True);click('Drafts (1)');assert contains('Review the project tests')
click('Open draft');click('Delete');click('Delete');assert contains('A place for your next idea')
print('PASS: navigation, edit PC, save draft, persistence after restart, delete draft')

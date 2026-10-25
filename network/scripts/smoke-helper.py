#!/usr/bin/env python3
"""Starts an unregistered temporary node; never signs into an account or prints its login URL."""
import json,os,pathlib,secrets,select,subprocess,tempfile,time,urllib.request,urllib.error
root=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='workbench-network-test-') as directory:
    token=secrets.token_hex(32)
    env={k:v for k,v in os.environ.items() if k not in ('TS_AUTHKEY','TS_ID_TOKEN','TS_CONTROL_URL')}
    process=subprocess.Popen([str(root/'build/workbench-network')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
    try:
        process.stdin.write(json.dumps({'dir':directory,'name':'workbench-transport-test','token':token,'port':0})+'\n');process.stdin.flush()
        assert select.select([process.stdout],[],[],20)[0],'Helper startup timed out'
        address=json.loads(process.stdout.readline())['address'];assert address.startswith('127.0.0.1:')
        def request(path,body=None,auth=token,origin=None):
            headers={'Authorization':'Bearer '+auth}
            if origin:headers['Origin']=origin
            data=None if body is None else json.dumps(body).encode()
            with urllib.request.urlopen(urllib.request.Request('http://'+address+'/'+path,data=data,headers=headers),timeout=35) as response:return json.load(response)
        for kwargs in ({'auth':'wrong'},{'origin':'https://untrusted.example'}):
            try:request('status',**kwargs);raise AssertionError('Unauthenticated or browser request accepted')
            except urllib.error.HTTPError as error:assert error.code==401
        request('login',{})
        for attempt in range(15):
            status=request('status')
            if status.get('authUrl') or status.get('state')=='Running':break
            time.sleep(1)
        assert status['enabled'] and status['state'] in ('NeedsLogin','Running','NeedsMachineAuth'),status
        assert status.get('authUrl') or status['state']=='Running','Sign-in URL unavailable'
        print('PASS: private helper authentication, browser-origin rejection, node startup, interactive sign-in availability')
    finally:
        process.stdin.close()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()

#!/usr/bin/env python3
"""Opt-in real launchd/signing drill. Only creates com.tango.install-fixture.* jobs."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

if sys.platform != 'darwin':
    raise SystemExit('macOS required')
root = Path(tempfile.mkdtemp(prefix='tango-install-fixture-')).resolve()
label = 'com.tango.install-fixture.' + uuid.uuid4().hex
job = f'gui/{os.getuid()}/{label}'
installer = Path(__file__).resolve().parents[1]/'scripts/install-app.py'
node = Path(shutil.which('node')).resolve()

def run(*args, check=True):
    return subprocess.run(args, text=True, capture_output=True, check=check)

def wait(predicate):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        try:
            if predicate(): return
        except Exception: pass
        time.sleep(.2)
    raise RuntimeError('fixture timeout')

# An ephemeral loopback port, never a production endpoint.
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
(root/'token').write_text('fixture-token')
(root/'maintenance.json').write_text('{"on":false}')
(root/'helper.c').write_text('#include <stdio.h>\nint main(){puts("com.tango.server: not registered");return 0;}\n')
run('/usr/bin/clang', str(root/'helper.c'), '-o', str(root/'Tango'))
(root/'server.cjs').write_text(r'''
const fs = require('fs'), http = require('http'), path = require('path');
const root = process.env.FIXTURE_ROOT;
const version = fs.readFileSync(path.join(path.dirname(process.execPath), '../Resources/version'), 'utf8');
const log = event => fs.appendFileSync(root+'/events.jsonl', JSON.stringify({event, pid:process.pid, version, at:Date.now()})+'\n');
try { fs.mkdirSync(root+'/owner.lock'); } catch { log('OVERLAP'); process.exit(20); }
log('start');
const {spawn} = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
let childStopped = false;
const stopChild = () => new Promise(resolve => {
 if(childStopped) return resolve();
 child.once('exit', (code, signal) => {childStopped=true;log('child-exit-'+signal);resolve();});
 child.kill('SIGTERM');
});
const state = () => JSON.parse(fs.readFileSync(root+'/maintenance.json', 'utf8'));
const server = http.createServer(async (req,res) => {
 let body=''; for await(const chunk of req) body+=chunk;
 let result;
 if(req.url==='/health') result={ok:version!=='bad', startedAt:String(process.pid)};
 else if(req.headers.authorization!=='Bearer fixture-token') {res.writeHead(401); return res.end('{}');}
 else if(req.url==='/maintenance') {
   if(body) {
     fs.writeFileSync(root+'/maintenance.json',body);
     // Model the real proxy timing out AFTER Loom committed maintenance off.
     if(JSON.parse(body).on===false) {res.writeHead(502);return res.end('{"ok":false,"code":"upstream_error"}');}
   }
   result={...state(), running:0, queued:2};
 } else if(req.url==='/services') result={services:[{id:'fixture-child',mode:'managed',state:childStopped?'stopped':'running',pid:childStopped?null:child.pid,health:{ok:!childStopped}}]};
 else if(req.url==='/services/fixture-child/stop') {await stopChild();result={ok:true};}
 else {res.writeHead(404);return res.end('{}');}
 res.end(JSON.stringify(result));
});
server.listen(Number(process.env.FIXTURE_PORT),'127.0.0.1');
process.on('SIGTERM',async()=>{log('term');await stopChild();server.close(()=>{fs.rmdirSync(root+'/owner.lock');log('exit');process.exit(0);});});
''')

def app(name, version):
    dest = root/name
    for directory in ['MacOS','Resources','Library/LaunchAgents']:
        (dest/'Contents'/directory).mkdir(parents=True,exist_ok=True)
    shutil.copy2(root/'Tango', dest/'Contents/MacOS/Tango')
    shutil.copy2(node,dest/'Contents/MacOS/tango-server-node')
    (dest/'Contents/Resources/version').write_text(version)
    (dest/'Contents/Info.plist').write_bytes(plistlib.dumps(dict(CFBundleExecutable='Tango', CFBundleIdentifier=label, CFBundlePackageType='APPL')))
    (dest/'Contents/Library/LaunchAgents/com.tango.server.plist').write_bytes(plistlib.dumps({'Label':label+'.login'}))
    run('/usr/bin/codesign','-s','-','--force',str(dest))
    run('/usr/bin/codesign','--verify','--deep','--strict',str(dest))
    assert hashlib.sha256(node.read_bytes()).digest()==hashlib.sha256((dest/'Contents/MacOS/tango-server-node').read_bytes()).digest()
    return dest

target=app('Tango.app','old')
good=app('good.app','new')
bad=app('bad.app','bad')
plist=root/'server.plist'
plist.write_bytes(plistlib.dumps(dict(Label=label, ProgramArguments=[str(target/'Contents/MacOS/tango-server-node'),str(root/'server.cjs')], RunAtLoad=True, KeepAlive=True, ExitTimeOut=30, EnvironmentVariables={'FIXTURE_ROOT':str(root),'FIXTURE_PORT':str(port)}, StandardOutPath=str(root/'stdout'),StandardErrorPath=str(root/'stderr'))))
def health():
    with urllib.request.urlopen(url+'/health',timeout=2) as r: return json.load(r)['ok']
def install(source, expected):
    result=run(sys.executable,str(installer),str(source),'--target',str(target),'--plist',str(plist),'--label',label,'--login-label',label+'.login','--url',url,'--token',str(root/'token'),'--timeout','5','--interrupt-services','fixture-child',check=False)
    (root/(source.stem+'-install.log')).write_text(result.stdout+'\n'+result.stderr)
    assert result.returncode==expected, result.stdout+'\n'+result.stderr
    wait(health)
try:
    run('/bin/launchctl','bootstrap',f'gui/{os.getuid()}',str(plist))
    wait(health)
    # An unrelated process holding the installed bundle must abort before downtime.
    holder = subprocess.Popen([sys.executable, '-c',
        'import sys,time; f=open(sys.argv[1]); print("ready",flush=True); time.sleep(60)',
        str(target/'Contents/MacOS/Tango')], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().strip() == 'ready'
        install(good,1)
        assert 'Quit Tango.app' in (root/'good-install.log').read_text()
        assert not json.loads((root/'maintenance.json').read_text())['on']
        assert len((root/'events.jsonl').read_text().splitlines()) == 1
    finally:
        holder.terminate()
        holder.wait(timeout=5)
    install(good,0)
    assert 'maintenance-response-uncertain' in (root/'good-install.log').read_text()
    assert 'backup-restored' not in (root/'good-install.log').read_text()
    assert not list(root.glob('.tango-install-*/original.app'))
    assert (target/'Contents/Resources/version').read_text()=='new'
    install(bad,1)
    assert (target/'Contents/Resources/version').read_text()=='new'
    assert not json.loads((root/'maintenance.json').read_text())['on']
    run('/bin/launchctl','bootout',job)
    wait(lambda:not (root/'owner.lock').exists())
    events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
    supervisor_events = [e['event'] for e in events if not e['event'].startswith('child-exit-')]
    assert supervisor_events==['start','term','exit']*4, events
    assert [e['event'] for e in events if e['event'].startswith('child-exit-')]==['child-exit-SIGTERM']*4, events
    assert [e['version'] for e in events if e['event']=='start']==['old','new','bad','new']
    assert not (root/'stderr').read_text().strip(), (root/'stderr').read_text()
    print(json.dumps({'ok':True,'fixture':str(root),'events':events,'checks':['install','health failure rollback','upstream Node unchanged','no overlap','all exits orderly SIGTERM','maintenance restored','empty stderr','managed child interruption accounted and recovered']}))
finally:
    run('/bin/launchctl','bootout',job,check=False)
    # Retain logs and bundles for evidence, never touch a real server label.

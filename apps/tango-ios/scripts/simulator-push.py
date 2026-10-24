#!/usr/bin/env python3
"""Local-only UI-test helper. Requires the sandbox desk on 9461 (Loom on 9463).
Pass the disposable simulator UDID and the sandbox Loom directory printed by desk:test.
Never pass a live Loom directory. No APNs credentials or production services are used.
"""
import http.server
import json
import pathlib
import subprocess
import sys
import urllib.request
import uuid

simulator, loom_home = sys.argv[1:]
home = pathlib.Path(loom_home).resolve()
if not str(home).startswith('/tmp/loom-desk-') and not str(home).startswith('/private/tmp/loom-desk-'):
    raise SystemExit('Only a desk:test sandbox Loom directory is allowed')
token = (home / 'token').read_text().strip()

def loom(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:9463' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as response:
        return json.load(response)

snapshot = loom('/snapshot')
threads = snapshot['threads']
thread = next(t for t in threads if t.get('title') == 'Sandbox README tidy')
brief = {'class': 'design-direction', 'about': 'Layout choice', 'ask': 'Choose the compact layout for the test desk?',
    'door': 'two-way', 'blast': 'private', 'standing': 'The sandbox has three layout choices.',
    'background': 'This decision tests notification answers with invented data.',
    'options': [{'key': 'A', 'label': 'Compact', 'consequence': 'Uses less space.', 'recommended': True},
                {'key': 'B', 'label': 'Roomy', 'consequence': 'Uses more space.'},
                {'key': 'C', 'label': 'Keep current', 'consequence': 'Leaves the layout alone.'}],
    'assets': [], 'precedents': [], 'blocks': [], 'proposedRule': 'Next time, for sandbox layout tests, choose Compact without asking'}
result = loom('/commands', {'commandId': str(uuid.uuid4()), 'type': 'decision.request', 'threadId': thread['id'], 'brief': brief})
print(json.dumps(result), flush=True)
# Read the desk's projection, including its revision and exact web answer labels.
import time
registration = urllib.request.Request('http://127.0.0.1:9461/api/desk/devices',
    data=json.dumps({'token': 'ab' * 32, 'platform': 'ios', 'bundleId': 'org.example.TangoDesk', 'environment': 'sandbox'}).encode(),
    headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(registration) as response: desk_id = json.load(response)['deskId']
payload = None
for _ in range(30):
    with urllib.request.urlopen('http://127.0.0.1:9461/api/desk/items') as response:
        items = json.load(response)['items']
    row = next((i for i in items if i['id'] == 'loom:' + thread['id'] and (i.get('facts', {}).get('pending') or {}).get('brief', {}).get('id') == result['result']['decisionId']), None)
    if row:
        pending = row['facts']['pending']; b = pending['brief']
        choices = pending['questions'][0]['options']
        options = [{'key': chr(65+i), 'label': o['label'].split(' · ', 1)[-1].replace(' (Recommended)', ''), 'answer': o['label']} for i,o in enumerate(choices)]
        payload = {'aps': {'alert': {'title': b['about'], 'body': pending['question'] + '\n' + '\n'.join(o['key'] + ' · ' + o['label'] for o in options)}, 'category': 'decision-3'}, 'deskId': desk_id, 'itemId': row['id'], 'requestId': pending['requestId'], 'decisionId': b['id'], 'revision': b['revision'], 'options': options}
        break
    time.sleep(.2)
if not payload: raise SystemExit('Sandbox decision did not reach desk')

class Handler(http.server.BaseHTTPRequestHandler):
    desk_status = 200

    def do_GET(self):
        if self.path.startswith("/http-status/"):
            Handler.desk_status = int(self.path.rsplit("/", 1)[-1])
            self.send_response(200); self.end_headers(); return
        if self.path == "/":
            self.send_response(Handler.desk_status)
            self.send_header("Content-Type", "text/html")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b"<html><body><h1>Recovered desk</h1></body></html>")
            return
        if self.path == '/done':
            req = urllib.request.Request('http://127.0.0.1:9461/api/desk/commands',
                data=json.dumps({'commandId': str(uuid.uuid4()), 'type': 'done', 'itemId': payload['itemId']}).encode(),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req) as response: result = response.read()
            self.send_response(200); self.end_headers(); self.wfile.write(result); return
        if self.path == '/open':
            result = subprocess.run(['xcrun', 'simctl', 'openurl', simulator, 'tango://decision/' + payload['decisionId']], text=True, capture_output=True)
            self.send_response(200 if result.returncode == 0 else 500)
            self.end_headers(); self.wfile.write((result.stdout + result.stderr).encode()); return
        if self.path == '/item':
            with urllib.request.urlopen('http://127.0.0.1:9461/api/desk/items/' + payload['itemId']) as response:
                row = json.load(response)['item']
            print(json.dumps({'event': 'snooze-check', 'itemId': row['id'],
                'disposition': row['disposition'], 'snoozeUntil': row['snoozeUntil'], 'checkedAt': int(time.time() * 1000)}), flush=True)
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(row).encode()); return
        if self.path == '/answered':
            decision = loom('/decisions/' + payload['decisionId'])
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(decision).encode()); return
        if self.path not in ['/push', '/foreign-push', '/foreign-failure']: self.send_error(404); return
        outgoing = payload
        if self.path == '/foreign-push':
            outgoing = {**payload, 'deskId': str(uuid.uuid4()), 'aps': {**payload['aps'], 'category': 'decision-open'}}
        if self.path == '/foreign-failure':
            outgoing = {**payload, 'deskId': str(uuid.uuid4()), 'deskAddress': 'http://127.0.0.1:9461',
                'aps': {**payload['aps'], 'category': 'decision-failure'}}
        result = subprocess.run(['xcrun', 'simctl', 'push', simulator, 'org.example.TangoDesk', '-'], input=json.dumps(outgoing), text=True, capture_output=True)
        self.send_response(200 if result.returncode == 0 else 500)
        self.end_headers(); self.wfile.write((result.stdout + result.stderr).encode())
print('Local push helper ready on 9464; decision ' + payload['decisionId'], flush=True)
http.server.HTTPServer(('127.0.0.1', 9464), Handler).serve_forever()

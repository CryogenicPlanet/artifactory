"""Disposable QEMU guest only: verify real compiled-runtime kernel recovery."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/home/ubuntu/comms')
DATA = ROOT / 'reboot-data'
PROOF = ROOT / 'reboot-proof.json'
COOKIE = ROOT / 'reboot-cookie'
URL = 'http://127.0.0.1:8080'
BODY = 'acknowledged before guest hard reset'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def rows(statement, params=()):
    with sqlite3.connect(DATA / 'boot.db', timeout=5) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(statement, params)]


def http(path, body=None, key=None):
    headers = {'cookie': COOKIE.read_text(), 'origin': 'https://comms.test'}
    if key:
        headers['idempotency-key'] = key
    encoded = None if body is None else json.dumps(body).encode()
    if encoded is not None:
        headers['content-type'] = 'application/json'
    request = urllib.request.Request(URL + path, data=encoded, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        require(response.status == 200, 'Unexpected HTTP status')
        return json.load(response)


def wait_for(check, label, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, sqlite3.Error, urllib.error.URLError):
            pass
        time.sleep(0.25)
    raise RuntimeError('Timed out: ' + label)


def start():
    DATA.mkdir(exist_ok=True)
    environment = dict(os.environ, DATA_DIR=str(DATA), RP_ID='comms.test',
                       PUBLIC_ORIGIN='https://comms.test', HOST='127.0.0.1', PORT='8080')
    # The real compiled launcher owns its real immutable keeper; no boot-ID injection.
    with (ROOT / 'reboot-runtime.log').open('ab') as log:
        subprocess.Popen(['bun', 'packages/server/dist/main.js'], cwd=ROOT,
                         env=environment, stdin=subprocess.DEVNULL, stdout=log,
                         stderr=log, start_new_session=True)


def live():
    status = http('/_boot/status')['child']
    require(status['state'] != 'failed', 'Child startup failed: ' + str(status.get('error')))
    return status if status['state'] == 'live' else None


def verify_unreceipted(proof):
    for owner in proof['owners']:
        current = rows('SELECT id,boot_id,opened,closed,receipt FROM child_attempts WHERE id=?', (owner['id'],))
        require(current == [owner], 'Old attempt changed before recovery')
        require(not Path(owner['receipt']).exists(), 'Unexpected keeper closure receipt')


def before():
    require(not PROOF.exists(), 'Guest test must start on fresh data')
    start()
    wait_for(lambda: rows("SELECT name FROM sqlite_master WHERE name='sessions'"), 'auth schema')
    token = secrets.token_urlsafe(32)
    COOKIE.write_text('__Host-comms_session=' + token)
    COOKIE.chmod(0o600)
    # Fixture setup creates only a hashed session, as existing HTTP transport tests do.
    rows('INSERT INTO sessions(id,hash,created_at,expires_at) VALUES(?,?,0,9999999999999)',
         (secrets.token_hex(16), hashlib.sha256(token.encode()).hexdigest()))
    child = wait_for(live, 'initial live child')
    response = http('/api/messages', {'topic': 'reboot-proof', 'body': BODY}, 'guest-reboot-write')
    owners = rows('SELECT id,boot_id,opened,closed,receipt FROM child_attempts WHERE opened=1 AND closed=0')
    require(len(owners) == 1, 'Expected one live child attempt')
    identity = boot_id()
    require(all(owner['boot_id'] == identity for owner in owners), 'Attempt lacks actual current kernel identity')
    require(Path('/proc/' + str(child['pid'])).exists(), 'Child disappeared before reset')
    proof = {'boot_id': identity, 'owners': owners, 'response': response}
    verify_unreceipted(proof)
    PROOF.write_text(json.dumps(proof))
    # Do not sync guest disks here: acknowledged production writes must already be durable.
    print('Acknowledged write; live attempt has no closure receipt', flush=True)


def inspect():
    proof = json.loads(PROOF.read_text())
    require(boot_id() != proof['boot_id'], 'Kernel did not reboot')
    verify_unreceipted(proof)
    print('Changed real kernel boot ID; old attempt still open without receipt', flush=True)


def after():
    inspect()
    proof = json.loads(PROOF.read_text())
    start()
    wait_for(live, 'recovered live child')
    for owner in proof['owners']:
        require(rows('SELECT closed FROM child_attempts WHERE id=?', (owner['id'],)) == [{'closed': 1}],
                'Old attempt not closed by changed-kernel recovery')
        require(not Path(owner['receipt']).exists(), 'Recovery unexpectedly depended on keeper receipt')
    replay = http('/api/messages', {'topic': 'reboot-proof', 'body': BODY}, 'guest-reboot-write')
    require(replay == proof['response'], 'Acknowledged idempotency outcome changed across reboot')
    result = http('/api/sql', {'sql': 'SELECT body FROM messages ORDER BY seq'})
    require(result['rows'] == [{'body': BODY}], 'Acknowledged message missing or duplicated')
    http('/api/messages', {'topic': 'reboot-proof', 'body': 'accepted after guest reboot'})
    require(len(http('/api/sql', {'sql': 'SELECT body FROM messages ORDER BY seq'})['rows']) == 2,
            'New writes unavailable after recovery')
    print('PASS: kernel changed, unreceipted owner recovered, acknowledged write retained exactly once, new write accepted')


if __name__ == '__main__':
    require(str(ROOT) == os.getcwd(), 'Run only in the disposable guest checkout')
    {'before': before, 'inspect': inspect, 'after': after}[sys.argv[1]]()

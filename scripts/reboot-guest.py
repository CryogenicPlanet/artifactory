"""Disposable QEMU guest only: verify real compiled-runtime kernel recovery."""
import hashlib
import json
import os
import re
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


def messages(topic=None):
    statement = 'SELECT * FROM messages'
    params = []
    if topic is not None:
        statement += ' WHERE topic=?'
        params.append(topic)
    result = http('/api/sql', {'sql': statement + ' ORDER BY seq', 'params': params})
    require(not result['truncated'], 'Message proof query was truncated')
    return result['rows']


def http_failure(error):
    # Do not echo arbitrary server text: only these fixed storage codes/hints.
    hints = {
        'storage_headroom': 'Free space on the data volume before new reservations; recovery evidence is retained.',
        'storage_measurement_failed': 'Inspect the data volume and failed storage probe before retrying.',
        'event_storage_unavailable': 'Inspect event storage measurements before allocating more events.',
        'event_storage_over_budget': 'Expand storage or wait for eligible event pruning; retained recovery evidence cannot be discarded.',
    }
    detail = {'status': error.code, 'code': 'unrecognized', 'hint': None}
    try:
        raw = error.read(4097)
        value = json.loads(raw) if len(raw) <= 4096 else None
        envelope = value.get('error') if isinstance(value, dict) else None
        code = envelope.get('code') if isinstance(envelope, dict) else None
        if isinstance(code, str) and code in hints:
            detail['code'] = code
            if envelope.get('hint') == hints[code]:
                detail['hint'] = hints[code]
    except (ValueError, OSError):
        pass
    print('Guest terminal HTTP refusal:', detail, flush=True)


def diagnostic():
    # Only structured state and counts: never print cookies, setup codes or raw logs.
    try:
        status = http('/_boot/status')['child']
        print('Guest child:', {key: status.get(key) for key in ('state', 'error', 'attempt')}, flush=True)
    except urllib.error.HTTPError as error:
        code = None
        try:
            value = json.load(error).get('error', {}).get('code')
            if isinstance(value, str) and re.fullmatch(r'[a-z_]{1,64}', value):
                code = value
        except (ValueError, AttributeError):
            pass
        print('Guest status refused:', error.code, code, flush=True)
    except Exception as error:
        print('Guest status unavailable:', type(error).__name__, flush=True)
    for name, statement in [
        ('generations', 'SELECT n,status,good FROM generations ORDER BY n'),
        ('attempts', 'SELECT opened,closed,COUNT(*) AS count FROM child_attempts GROUP BY opened,closed'),
    ]:
        try:
            print('Guest ' + name + ':', rows(statement), flush=True)
        except sqlite3.Error as error:
            print('Guest database diagnostic unavailable:', type(error).__name__, flush=True)
    try:
        volume = os.statvfs(DATA)
        print('Guest storage sample:', {
            'capacity_bytes': volume.f_frsize * volume.f_blocks,
            'available_bytes': volume.f_frsize * volume.f_bavail,
            'available_inodes': volume.f_favail,
            'boot_db_bytes': {suffix or 'main': (DATA / ('boot.db' + suffix)).stat().st_size
                              for suffix in ('', '-wal', '-shm') if (DATA / ('boot.db' + suffix)).exists()},
        }, flush=True)
        policy_rows = rows("SELECT value FROM settings WHERE key='storage_policy'")
        policy = json.loads(policy_rows[0]['value']) if policy_rows else {}
        print('Guest stored storage policy (empty means defaults):', {
            key: policy[key] for key in ('backup_percent', 'event_percent', 'headroom_percent')
            if isinstance(policy, dict) and type(policy.get(key)) in (int, float)
            and 0 <= policy[key] <= 100
        }, flush=True)
    except (OSError, sqlite3.Error, ValueError) as error:
        print('Guest storage diagnostic unavailable:', type(error).__name__, flush=True)
    log = ROOT / 'reboot-runtime.log'
    if log.exists():
        text = log.read_text(errors='replace')
        print('Guest runtime log summary:', {
            'bytes': log.stat().st_size,
            'listener_announced': 'Listening on' in text,
            'event_maintenance_failed': 'Event page-budget maintenance failed; retrying next minute' in text,
            'error_codes': sorted(set(re.findall(r'code: [\"\']([a-z_]{1,64})[\"\']', text))),
        }, flush=True)


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
    diagnostic()
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
    print('Guest initial runtime start:', time.monotonic(), flush=True)
    start()
    wait_for(lambda: rows("SELECT name FROM sqlite_master WHERE name='sessions'"), 'auth schema')
    token = secrets.token_urlsafe(32)
    COOKIE.write_text('__Host-comms_session=' + token)
    COOKIE.chmod(0o600)
    # Fixture setup creates only a hashed session, as existing HTTP transport tests do.
    rows('INSERT INTO sessions(id,hash,created_at,expires_at) VALUES(?,?,0,9999999999999)',
         (secrets.token_hex(16), hashlib.sha256(token.encode()).hexdigest()))
    print('Guest auth schema ready:', time.monotonic(), flush=True)
    child = wait_for(live, 'initial live child')
    print('Guest initial child live:', time.monotonic(), flush=True)
    response = http('/api/messages', {'topic': 'reboot-proof', 'body': BODY}, 'guest-reboot-write')
    owners = rows('SELECT id,boot_id,opened,closed,receipt FROM child_attempts WHERE opened=1 AND closed=0')
    require(len(owners) == 1, 'Expected one live child attempt')
    identity = boot_id()
    require(all(owner['boot_id'] == identity for owner in owners), 'Attempt lacks actual current kernel identity')
    require(Path('/proc/' + str(child['pid'])).exists(), 'Child disappeared before reset')
    proof = {'boot_id': identity, 'owners': owners, 'response': response, 'messages': messages()}
    require([row['body'] for row in proof['messages'] if row['topic'] == 'reboot-proof'] == [BODY],
            'Expected exactly one acknowledged user message before reset')
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
    recovered = {row['id']: row for row in messages()}
    # System projection can append new messages after reboot. Every earlier row,
    # including its full contents and sequence, must nevertheless survive intact.
    for previous in proof['messages']:
        require(recovered.get(previous['id']) == previous, 'Pre-reset message changed or disappeared')
    require([row['body'] for row in messages('reboot-proof')] == [BODY],
            'Acknowledged user message missing or duplicated')
    created = http('/api/messages', {'topic': 'reboot-proof', 'body': 'accepted after guest reboot'})
    require(created['seq'] > proof['response']['seq'], 'Sequence did not advance across recovery')
    require([row['body'] for row in messages('reboot-proof')] == [BODY, 'accepted after guest reboot'],
            'New writes unavailable after recovery')
    print('PASS: kernel changed, unreceipted owner recovered, acknowledged write retained exactly once, new write accepted')


if __name__ == '__main__':
    require(str(ROOT) == os.getcwd(), 'Run only in the disposable guest checkout')
    try:
        {'before': before, 'inspect': inspect, 'after': after}[sys.argv[1]]()
    except urllib.error.HTTPError as error:
        http_failure(error)
        diagnostic()
        raise

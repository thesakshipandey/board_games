"""One-time Supabase setup through the Management API.

Reads secrets from a private KEY=VALUE file (never commit it):
  SUPABASE_REF          project ref (the subdomain of the Project URL)
  SUPABASE_PAT          personal access token (Account > Access Tokens)
  ADMIN_EMAILS          owner account(s), comma separated
  APPS_SCRIPT_URL       web app URL that sends the welcome email
  WELCOME_SECRET        shared secret for that call (generated if missing)
  GMAIL_USER            Gmail address the account emails come from      (optional until you have it)
  GMAIL_APP_PASSWORD    16-character Gmail app password                  (optional until you have it)
  GOOGLE_CLIENT_ID      OAuth client for "Continue with Google"          (optional)
  GOOGLE_CLIENT_SECRET  its secret                                       (optional)

Usage:  python3 -I tools/supabase_setup.py /path/to/supabase.env [schema|settings|auth|keys|all]
Writes SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY back into the same env file.
"""
import json, pathlib, secrets, sys, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = 'https://thesakshipandey.github.io/boardgame/'
API = 'https://api.supabase.com/v1/projects/'


def load_env(p):
    env = {}
    for line in pathlib.Path(p).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


def save_env(p, env):
    pathlib.Path(p).write_text(''.join(f'{k}={v}\n' for k, v in env.items()))


def call(env, method, path, body=None):
    req = urllib.request.Request(API + env['SUPABASE_REF'] + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': 'Bearer ' + env['SUPABASE_PAT'], 'Content-Type': 'application/json',
                                          'User-Agent': 'game-shelf-setup'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {path} -> HTTP {e.code}: {e.read().decode()[:800]}')


def sql(env, query):
    return call(env, 'POST', '/database/query', {'query': query})


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def do_schema(env):
    sql(env, (ROOT / 'supabase' / 'schema.sql').read_text())
    print('schema applied')


def do_settings(env):
    env.setdefault('WELCOME_SECRET', secrets.token_urlsafe(24))
    rows = {'admin_emails': env.get('ADMIN_EMAILS', ''), 'welcome_url': env.get('APPS_SCRIPT_URL', ''),
            'welcome_secret': env['WELCOME_SECRET']}
    values = ','.join(f'({q(k)},{q(v)})' for k, v in rows.items() if v)
    sql(env, f'insert into private.settings (key, value) values {values} on conflict (key) do update set value = excluded.value;')
    print('settings saved:', ', '.join(k for k, v in rows.items() if v))


def do_auth(env):
    mail = ROOT / 'supabase' / 'email'
    cfg = {
        'site_url': SITE,
        'uri_allow_list': ','.join([SITE, SITE + '**', 'http://localhost:8765/**']),
        'external_email_enabled': True,
        'mailer_autoconfirm': False,
        'mailer_secure_email_change_enabled': True,
        'password_min_length': 8,
        'mailer_otp_exp': 86400,
        'mailer_subjects_confirmation': 'Confirm your email · The Game Shelf',
        'mailer_templates_confirmation_content': (mail / 'confirm.html').read_text(),
        'mailer_subjects_recovery': 'Reset your password · The Game Shelf',
        'mailer_templates_recovery_content': (mail / 'recovery.html').read_text(),
        'mailer_subjects_magic_link': 'Your sign-in link · The Game Shelf',
        'mailer_templates_magic_link_content': (mail / 'magic_link.html').read_text(),
        'mailer_subjects_email_change': 'Confirm your new email · The Game Shelf',
        'mailer_templates_email_change_content': (mail / 'email_change.html').read_text(),
    }
    if not (env.get('GMAIL_USER') and env.get('GMAIL_APP_PASSWORD')):
        # Supabase only allows custom templates with your own SMTP sender.
        cfg = {k: v for k, v in cfg.items() if not k.startswith('mailer_templates_') and not k.startswith('mailer_subjects_')}
    else:
        cfg.update({'smtp_admin_email': env['GMAIL_USER'], 'smtp_host': 'smtp.gmail.com', 'smtp_port': '465',
                    'smtp_user': env['GMAIL_USER'], 'smtp_pass': env['GMAIL_APP_PASSWORD'].replace(' ', ''),
                    'smtp_sender_name': 'The Game Shelf', 'smtp_max_frequency': 30, 'rate_limit_email_sent': 60})
    if env.get('GOOGLE_CLIENT_ID') and env.get('GOOGLE_CLIENT_SECRET'):
        cfg.update({'external_google_enabled': True, 'external_google_client_id': env['GOOGLE_CLIENT_ID'],
                    'external_google_secret': env['GOOGLE_CLIENT_SECRET']})
    call(env, 'PATCH', '/config/auth', cfg)
    print('auth configured:', 'smtp' if 'smtp_host' in cfg else 'no smtp yet', '|', 'google' if 'external_google_enabled' in cfg else 'no google yet')


def do_keys(env):
    keys = call(env, 'GET', '/api-keys?reveal=true') or []
    by = {}
    for k in keys:
        by[k.get('name') or k.get('type')] = k.get('api_key')
    anon = by.get('anon') or next((k['api_key'] for k in keys if k.get('type') == 'publishable'), '')
    service = by.get('service_role') or next((k['api_key'] for k in keys if k.get('type') == 'secret'), '')
    env['SUPABASE_URL'] = f"https://{env['SUPABASE_REF']}.supabase.co"
    env['SUPABASE_ANON_KEY'], env['SUPABASE_SERVICE_KEY'] = anon, service
    print('keys fetched: anon', 'yes' if anon else 'NO', '| service', 'yes' if service else 'NO')


def main():
    path, step = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'all')
    env = load_env(path)
    steps = {'schema': do_schema, 'settings': do_settings, 'auth': do_auth, 'keys': do_keys}
    for name in (steps if step == 'all' else [step]):
        steps[name](env)
    save_env(path, env)


if __name__ == '__main__':
    main()

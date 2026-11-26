"""Builds the account emails (one shared layout) into supabase/email/*.html.

Supabase templates use Go template tags ({{ .ConfirmationURL }}, {{ .Data.display_name }} ...).
welcome.html is sent by the Apps Script after sign-up and uses {{name}}-style placeholders.
Email clients ignore most CSS, so everything is inline and table based.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'supabase' / 'email'
SITE = 'https://thesakshipandey.github.io/boardgame/'
INK, MUTED, LINE, ACCENT = '#1d1a19', '#6f6965', '#ece7e3', '#c9785a'
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif"


def layout(preheader, title, intro, body, button=None, after=''):
    btn = ''
    if button:
        label, url = button
        btn = f'''<tr><td style="padding:8px 40px 6px">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:999px;background:{INK}">
    <a href="{url}" style="display:inline-block;padding:14px 30px;font:600 15px {FONT};color:#ffffff;text-decoration:none;border-radius:999px">{label}</a>
  </td></tr></table></td></tr>
<tr><td style="padding:14px 40px 0;font:400 12.5px/1.6 {FONT};color:{MUTED}">
  Button not working? Paste this link into your browser:<br>
  <a href="{url}" style="color:{ACCENT};word-break:break-all">{url}</a></td></tr>'''
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>{title}</title></head>
<body style="margin:0;padding:0;background:#f4f1ee">
<span style="display:none!important;opacity:0;color:transparent;max-height:0;overflow:hidden">{preheader}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ee"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:22px;overflow:hidden;box-shadow:0 10px 40px rgba(29,26,25,.08)">
<tr><td style="padding:0;background:#141212;background-image:linear-gradient(135deg,#6f4fb0 0%,#b76f6a 55%,#e7a98a 100%)">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td style="padding:26px 40px;font:700 13px {FONT};letter-spacing:.16em;text-transform:uppercase;color:#ffffff">&#127922;&nbsp; The Game Shelf</td>
  </tr></table></td></tr>
<tr><td style="padding:36px 40px 6px;font:600 26px/1.2 {FONT};letter-spacing:-.02em;color:{INK}">{title}</td></tr>
<tr><td style="padding:8px 40px 18px;font:400 15.5px/1.6 {FONT};color:#3d3836">{intro}</td></tr>
{body}
{btn}
{after}
<tr><td style="padding:30px 40px 34px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="border-top:1px solid {LINE};padding-top:18px;font:400 12px/1.6 {FONT};color:{MUTED}">
  The Game Shelf &middot; board, card and duel games with Indian store prices<br>
  <a href="{SITE}" style="color:{MUTED}">{SITE.replace('https://', '')}</a> &middot; Made with &#9829; by Sakshi
</td></tr></table></td></tr>
</table></td></tr></table></body></html>
'''


def details(rows):
    cells = ''.join(f'''<tr><td style="padding:10px 16px;font:600 11px {FONT};letter-spacing:.08em;text-transform:uppercase;color:{MUTED};width:38%;border-bottom:1px solid {LINE}">{k}</td>
      <td style="padding:10px 16px;font:500 14.5px {FONT};color:{INK};border-bottom:1px solid {LINE}">{v}</td></tr>''' for k, v in rows)
    return f'''<tr><td style="padding:0 40px 22px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"
  style="border:1px solid {LINE};border-radius:14px;border-collapse:separate;overflow:hidden">{cells}</table></td></tr>'''


def note(text):
    return f'<tr><td style="padding:18px 40px 0;font:400 13px/1.6 {FONT};color:{MUTED}">{text}</td></tr>'


def features(items):
    li = ''.join(f'''<tr><td style="padding:7px 0;vertical-align:top;width:30px;font:16px {FONT}">{icon}</td>
      <td style="padding:7px 0;font:400 14.5px/1.55 {FONT};color:#3d3836"><b style="color:{INK}">{head}</b><br>{text}</td></tr>''' for icon, head, text in items)
    return f'<tr><td style="padding:4px 40px 22px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">{li}</table></td></tr>'


TEMPLATES = {
    'confirm.html': layout(
        'One click to finish creating your Game Shelf account.',
        'Confirm your email',
        'Hi {{ if .Data.display_name }}{{ .Data.display_name }}{{ else }}there{{ end }}, thanks for signing up. '
        'Please confirm this is your email address to activate your account. Here is what you registered with:',
        details([('Display name', '{{ .Data.display_name }}'), ('Username', '@{{ .Data.username }}'), ('Email', '{{ .Email }}')]),
        ('Confirm my email', '{{ .ConfirmationURL }}'),
        note('This link works once and expires in 24 hours. If you did not create an account, ignore this email: nothing happens until the link is used.')),
    'recovery.html': layout(
        'Reset the password for your Game Shelf account.',
        'Reset your password',
        'We received a request to reset the password for <b>{{ .Email }}</b>. Choose a new one with the button below.',
        '',
        ('Choose a new password', '{{ .ConfirmationURL }}'),
        note('This link expires in 1 hour and can be used once. If you did not ask for this, you can safely ignore this email: your password stays the same.')),
    'magic_link.html': layout(
        'Your sign-in link for The Game Shelf.',
        'Your sign-in link',
        'Use the button below to sign in as <b>{{ .Email }}</b>. No password needed.',
        '',
        ('Sign in', '{{ .ConfirmationURL }}'),
        note('This link expires in 1 hour and can be used once. If you did not ask for it, ignore this email.')),
    'email_change.html': layout(
        'Confirm the new email address for your Game Shelf account.',
        'Confirm your new email',
        'You asked to change the email on your account.',
        details([('From', '{{ .Email }}'), ('To', '{{ .NewEmail }}')]),
        ('Confirm the change', '{{ .ConfirmationURL }}'),
        note('If you did not ask for this, ignore this email and your address stays the same.')),
    'welcome.html': layout(
        'Your account is ready. Here is everything in one place.',
        'Welcome to The Game Shelf, {{first}} &#127881;',
        'Your account is set up and ready. Here are your details for your records:',
        details([('Display name', '{{name}}'), ('Username', '@{{username}}'), ('Email', '{{email}}'),
                 ('Signed up with', '{{provider}}'), ('Member since', '{{joined}}')])
        + features([
            ('&#9989;', 'Track your shelf', 'Mark games as Owned, On the way or DIY, with the edition, price paid and whether the copy is original.'),
            ('&#11088;', 'Rate and log plays', 'Give games a score out of 10 and count how often they hit the table.'),
            ('&#128722;', 'Build a buy list', 'Wishlist anything and set a priority. We show the best in-stock price across 12 Indian stores.'),
            ('&#128101;', 'Find tonight\'s game', 'Search by player count and type; the games you own float to the top.'),
        ]),
        ('Open my shelf', SITE + '#shelf'),
        note('Your shelf is private: only you can see what you own, what you paid and your ratings. '
             'Questions or ideas? Just reply to this email.')),
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, html in TEMPLATES.items():
        (OUT / name).write_text(html, encoding='utf-8')
    print('wrote', ', '.join(TEMPLATES))


if __name__ == '__main__':
    main()

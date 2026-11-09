#!/usr/bin/env python3
# 给官端聊天应用（ChatGPT、Claude 这类能加 MCP 连接器的）用的连接器：MCP（直播卡＋看屏幕、浏览器工具）＋OAuth，工具调用经隧道转回家里的屏幕小程序。
# 无状态 Streamable HTTP，只回 JSON，不开 SSE。听 127.0.0.1:39271，VPS 上的 Caddy 按 path.txt 那条路转进来。
import base64, hashlib, hmac, html as htmlmod, json, os, secrets, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
PATH = open(os.path.join(BASE, 'path.txt')).read().strip()
MIME = 'text/html;profile=mcp-app'
# 域名、设备号不写死，读同目录 site.json（跟电脑上 deploy\site.json 同一份）
SITE_CFG = json.load(open(os.path.join(BASE, 'site.json'), encoding='utf-8'))
DOMAIN = SITE_CFG['domain']
ORIGIN = 'https://' + DOMAIN
SIG = ['wss://' + DOMAIN, ORIGIN]
VERSIONS = ('2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25')




def log(name, obj):
    with open(os.path.join(BASE, name), 'a', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False) + '\n')


# 直播卡：卡里套一扇你的网页客户端（#embed&card），CrossDesk 密码在框里由人亲手输，连接器不经手
LIVE_URI = 'ui://screen/live-v1.html'
DEVICE_ID = str(SITE_CFG.get('deviceId', ''))
LIVE_META = {'ui': {'csp': {'connectDomains': SIG, 'resourceDomains': [], 'frameDomains': [ORIGIN]},
                    'prefersBorder': True},
             'openai/widgetCSP': {'connect_domains': SIG, 'resource_domains': [],
                                  'frame_domains': [ORIGIN]},
             'openai/widgetDescription': "Live view of the user's own computer screen; she can touch it from here."}

TOOLS = [
    {'name': 'screen_live', 'title': 'Screen live',
     'description': "Show a live card of the user's own computer screen, which she can also touch. "
                    'Call it when the user asks to see her screen live. The card asks her for the password itself.',
     'inputSchema': {'type': 'object', 'properties': {}},
     'annotations': {'readOnlyHint': True},
     '_meta': {'ui': {'resourceUri': LIVE_URI}, 'ui/resourceUri': LIVE_URI}},
    {'name': 'card_report', 'description': 'Card-internal: store what the live card saw (connected or not, its own origin).',
     'inputSchema': {'type': 'object', 'properties': {'report': {'type': 'string'}}, 'required': ['report']},
     'annotations': {'readOnlyHint': True},
     '_meta': {'ui': {'visibility': ['app']}}},
]


# —— 给远程 AI 的手 ——
# 整个连接器挂在 OAuth 后面：聊天应用头一回连弹授权页，人输「新设备的码」给的六位数；码交给家里核（用掉就没了）。
# 工具都不标只读：聊天应用多半每一下都先问人（ChatGPT 是这样）。活儿在家里那台电脑上干（screen 小程序 /api/agent/remote），从 VPS 本机直接敲 39260、
# 带 relay.key；外面来的 /api/agent/remote* Caddy 一律 403。
ISSUER = ORIGIN
MCP_URL = ISSUER + PATH
HOME = os.environ.get('KAEL_HOME') or 'http://127.0.0.1:39260'   # 本机测试时指到家里 127.0.0.1:5261
RELAY = os.environ.get('KAEL_RELAY') or (open(os.path.join(BASE, 'relay.key')).read().strip() if os.path.exists(os.path.join(BASE, 'relay.key')) else '')
OAUTH_FILE = os.path.join(BASE, 'oauth.json')
ACCESS_TTL, REFRESH_TTL = 3600, 30 * 86400
LOCK = threading.Lock()
PENDING, CODES = {}, {}   # 授权页那一下、刚发出去的授权码：都只在内存里，几分钟就过期


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def load_oauth():
    try:
        return json.load(open(OAUTH_FILE, encoding='utf-8'))
    except Exception:
        return {'clients': {}, 'tokens': {}}


def save_oauth(d):
    tmp = OAUTH_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, OAUTH_FILE)


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def issue_tokens(d, client_id):
    now = int(time.time())
    for k in [k for k, v in d['tokens'].items() if v['exp'] < now]:
        del d['tokens'][k]
    at, rt = secrets.token_urlsafe(32), secrets.token_urlsafe(40)
    d['tokens'][sha(at)] = {'kind': 'access', 'client': client_id, 'exp': now + ACCESS_TTL}
    d['tokens'][sha(rt)] = {'kind': 'refresh', 'client': client_id, 'exp': now + REFRESH_TTL}
    return {'access_token': at, 'token_type': 'Bearer', 'expires_in': ACCESS_TTL, 'refresh_token': rt, 'scope': 'screen'}


def bearer_ok(header):
    if not header or not header.lower().startswith('bearer '):
        return False
    t = load_oauth()['tokens'].get(sha(header[7:].strip()))
    return bool(t and t['kind'] == 'access' and t['exp'] > time.time())


def home(path, body, timeout=75):
    req = urllib.request.Request(HOME + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Kael-Relay': RELAY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}
    except Exception as e:
        return 502, {'error': 'home unreachable: ' + str(e)[:120]}


PRM = {'resource': MCP_URL, 'authorization_servers': [ISSUER], 'bearer_methods_supported': ['header'],
       'scopes_supported': ['screen'], 'resource_name': 'Your computer'}
ASM = {'issuer': ISSUER, 'authorization_endpoint': ISSUER + '/oauth/authorize', 'token_endpoint': ISSUER + '/oauth/token',
       'registration_endpoint': ISSUER + '/oauth/register', 'response_types_supported': ['code'],
       'grant_types_supported': ['authorization_code', 'refresh_token'], 'code_challenge_methods_supported': ['S256'],
       'token_endpoint_auth_methods_supported': ['none'], 'scopes_supported': ['screen']}

AUTH_PAGE = '''<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>允许 {client} 用你的电脑？</title><style>
html,body{{margin:0;background:#eef0e8;color:#33402f;font:15px/1.6 -apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}}
main{{max-width:340px;margin:0 auto;padding:64px 22px 40px}}
h1{{font-size:21px;font-weight:600;margin:0 0 14px;letter-spacing:.02em}}
p{{margin:0 0 10px;color:#55604f}} ul{{margin:0 0 22px;padding-left:1.1em;color:#55604f}} li{{margin:2px 0}}
input{{display:block;width:100%;box-sizing:border-box;height:52px;border-radius:99px;border:1px solid rgba(60,72,52,.24);background:rgba(255,255,255,.7);
text-align:center;font-size:22px;letter-spacing:.42em;color:#33402f;outline:none;font-family:inherit}}
input::placeholder{{font-size:15px;letter-spacing:.06em;color:#7d8875}} input:focus{{border-color:rgba(170,140,70,.6)}}
.row{{display:flex;gap:10px;justify-content:center;margin-top:16px}}
button,a.no{{border-radius:99px;border:1px solid rgba(60,72,52,.24);background:rgba(255,255,255,.5);color:#33402f;padding:9px 24px;font-size:15px;font-family:inherit;text-decoration:none}}
button{{background:rgba(224,182,79,.22);border-color:rgba(170,140,70,.5)}}
.err{{min-height:20px;margin:12px 0 0;text-align:center;color:#a8503a;font-size:13px}}
</style></head><body><main>
<h1>允许 {client} 用你的电脑？</h1>
<p>允许以后，它能：</p>
<ul><li>看你的整块屏幕</li><li>在你的 Chrome 里开网页、点、打字（登着号的站也算）</li></ul>
<p>聊天应用多半每一下都会先问你；你在直播卡或操控台上按「我来」、或者碰一下鼠标键盘，它就停。</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="rid" value="{rid}">
<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="「新设备的码」给的六位数" autofocus>
<div class="err">{err}</div>
<div class="row"><a class="no" href="/oauth/deny?rid={rid}">不允许</a><button type="submit">允许</button></div>
</form></main></body></html>'''

REMOTE_TOOLS = [
    {'name': 'screen_look', 'title': 'Look at her screen',
     'description': "Take a screenshot of the user's whole computer screen (Windows, her own computer). "
                    'Use it to see what is on screen before and after acting.',
     'inputSchema': {'type': 'object', 'properties': {}},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
    {'name': 'browser_open', 'title': 'Open a page',
     'description': "Open a URL in a dedicated Chrome window on the user's computer (her own Chrome, so sites she is logged into "
                    'are logged in). Later browser_* calls act on this same window.',
     'inputSchema': {'type': 'object', 'properties': {'url': {'type': 'string', 'description': 'http(s) URL'}}, 'required': ['url']},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
    {'name': 'browser_state', 'title': 'Read the page',
     'description': 'Current URL, title and the interactive elements with [N] numbers. Use those numbers as the target of browser_click / browser_type.',
     'inputSchema': {'type': 'object', 'properties': {}},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
    {'name': 'browser_extract', 'title': 'Read the page text',
     'description': 'The readable text of the current page as markdown (for long articles).',
     'inputSchema': {'type': 'object', 'properties': {}},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
    {'name': 'browser_click', 'title': 'Click',
     'description': 'Click an element: a number N from browser_state, or a CSS selector.',
     'inputSchema': {'type': 'object', 'properties': {'target': {'type': 'string'}}, 'required': ['target']},
     'annotations': {'readOnlyHint': False, 'openWorldHint': True}},
    {'name': 'browser_type', 'title': 'Type',
     'description': 'Click an element (number from browser_state, or CSS selector), then type the text into it.',
     'inputSchema': {'type': 'object', 'properties': {'target': {'type': 'string'}, 'text': {'type': 'string'}}, 'required': ['target', 'text']},
     'annotations': {'readOnlyHint': False, 'openWorldHint': True}},
    {'name': 'browser_keys', 'title': 'Press a key',
     'description': 'Press a key in the page, e.g. Enter, Tab, Escape, ArrowDown, Control+a.',
     'inputSchema': {'type': 'object', 'properties': {'key': {'type': 'string'}}, 'required': ['key']},
     'annotations': {'readOnlyHint': False, 'openWorldHint': True}},
    {'name': 'browser_scroll', 'title': 'Scroll',
     'description': 'Scroll the page up or down.',
     'inputSchema': {'type': 'object', 'properties': {'direction': {'type': 'string', 'enum': ['up', 'down']}}, 'required': ['direction']},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
    {'name': 'browser_back', 'title': 'Go back',
     'description': 'Go back in this window\'s history.',
     'inputSchema': {'type': 'object', 'properties': {}},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
    {'name': 'browser_close', 'title': 'Close the window',
     'description': 'Close the Chrome window you opened. Do this when you are done.',
     'inputSchema': {'type': 'object', 'properties': {}},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
]
REMOTE_MAP = {'screen_look': 'look', 'browser_open': 'open', 'browser_state': 'state', 'browser_extract': 'extract',
           'browser_click': 'click', 'browser_type': 'type', 'browser_keys': 'keys', 'browser_scroll': 'scroll',
           'browser_back': 'back', 'browser_close': 'close'}
INSTRUCTIONS = ("These tools act on the user's own Windows computer, live, while she watches. Look before acting. "
                "If a tool says the user is holding control or using the computer, stop and tell them; do not retry in a loop. "
                "Never buy, pay, delete, or send messages/posts on their behalf unless they explicitly asked for that exact action.")


def remote_call(name, args):
    st, o = home('/api/agent/remote', {'tool': REMOTE_MAP[name], 'args': args})
    if st == 200 and o.get('ok'):
        content = [{'type': 'text', 'text': o.get('text') or '(done)'}]
        if o.get('image'):
            content.append({'type': 'image', 'data': o['image'], 'mimeType': 'image/jpeg'})
        return {'content': content}
    msg = o.get('error') or ('home answered %s' % st)
    return {'content': [{'type': 'text', 'text': msg}], 'isError': True}




def live_html():
    html = open(os.path.join(BASE, 'live.html'), encoding='utf-8').read()
    return html.replace('__EMBED__', json.dumps({'id': DEVICE_ID})).replace('__SITE__', json.dumps(ORIGIN))


def text(obj):
    return [{'type': 'text', 'text': json.dumps(obj, ensure_ascii=False)}]


def handle(msg, ua):
    mid, method, params = msg.get('id'), msg.get('method'), msg.get('params') or {}
    log('calls.jsonl', {'t': time.strftime('%H:%M:%S'), 'm': method,
                        'tool': params.get('name') if method == 'tools/call' else None, 'ua': ua[:80]})
    if mid is None:
        return None
    if method == 'initialize':
        pv = params.get('protocolVersion')
        r = {'protocolVersion': pv if pv in VERSIONS else '2025-06-18',
             'capabilities': {'tools': {'listChanged': False}, 'resources': {'listChanged': False},
                              'extensions': {'io.modelcontextprotocol/ui': {}}},
             'serverInfo': {'name': 'screen', 'version': '0.2'}, 'instructions': INSTRUCTIONS}
        log('calls.jsonl', {'client': params.get('clientInfo'), 'caps': params.get('capabilities')})
    elif method == 'ping':
        r = {}
    elif method == 'tools/list':
        r = {'tools': TOOLS + REMOTE_TOOLS}
    elif method == 'resources/list':
        r = {'resources': [{'uri': LIVE_URI, 'name': 'screen-live card', 'mimeType': MIME, '_meta': LIVE_META}]}
    elif method == 'resources/templates/list':
        r = {'resourceTemplates': []}
    elif method == 'prompts/list':
        r = {'prompts': []}
    elif method == 'resources/read':
        if params.get('uri') == LIVE_URI:
            r = {'contents': [{'uri': LIVE_URI, 'mimeType': MIME, 'text': live_html(), '_meta': LIVE_META}]}
        else:
            return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32602, 'message': 'unknown resource'}}
    elif method == 'tools/call':
        name, args = params.get('name'), params.get('arguments') or {}
        if name == 'screen_live':
            r = {'content': [{'type': 'text', 'text': 'Live card shown. She enters the password on the card if asked.'}],
                 'structuredContent': {'at': int(time.time())}}
        elif name == 'card_report':
            log('reports.jsonl', {'t': time.strftime('%Y-%m-%d %H:%M:%S'), 'ua': ua, 'report': args.get('report')})
            r = {'content': [{'type': 'text', 'text': 'saved'}]}
        elif name in REMOTE_MAP:
            r = remote_call(name, args)
            log('calls.jsonl', {'t': time.strftime('%H:%M:%S'), 'tool': name, 'err': bool(r.get('isError'))})
        else:
            return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32602, 'message': 'unknown tool'}}
    else:
        return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'method not found'}}
    return {'jsonrpc': '2.0', 'id': mid, 'result': r}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=None, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_header('Content-Length', '0')
            self.end_headers()

    def page(self, code, text):
        data = text.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')   # 授权页不许被别人套进框里骗人点
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, url):
        self.send_response(302)
        self.send_header('Location', url)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def body(self):
        return self.rfile.read(min(int(self.headers.get('Content-Length') or 0), 200000))

    def unauthorized(self):
        return self.send(401, {'error': 'invalid_token'}, {'WWW-Authenticate':
            'Bearer resource_metadata="%s/.well-known/oauth-protected-resource", error="invalid_token"' % ISSUER})

    # —— OAuth ——
    def auth_page(self, rid, err=''):
        p = PENDING.get(rid)
        name = (p or {}).get('client_name') or 'AI 应用'
        return self.page(200, AUTH_PAGE.format(client=htmlmod.escape(name[:40]), rid=htmlmod.escape(rid), err=htmlmod.escape(err)))

    def oauth_get(self, path, q):
        if path.startswith('/.well-known/oauth-protected-resource'):
            return self.send(200, PRM)
        if path.startswith('/.well-known/oauth-authorization-server') or path == '/.well-known/openid-configuration':
            return self.send(200, ASM)
        if path == '/oauth/authorize':
            g = lambda k: (q.get(k) or [''])[0]
            d = load_oauth()
            c = d['clients'].get(g('client_id'))
            if not c or g('redirect_uri') not in c['redirect_uris']:
                return self.page(400, '<p style="font:15px sans-serif;padding:40px">这个授权请求不认识（client 或回跳地址对不上）。</p>')
            if g('response_type') != 'code' or g('code_challenge_method') != 'S256' or not g('code_challenge'):
                return self.redirect(g('redirect_uri') + ('&' if '?' in g('redirect_uri') else '?') +
                                     urllib.parse.urlencode({'error': 'invalid_request', 'state': g('state')}))
            now = time.time()
            for k in [k for k, v in PENDING.items() if v['exp'] < now]:
                del PENDING[k]
            rid = secrets.token_urlsafe(18)
            PENDING[rid] = {'client_id': g('client_id'), 'client_name': c.get('client_name') or '', 'redirect_uri': g('redirect_uri'),
                            'challenge': g('code_challenge'), 'state': g('state'), 'scope': g('scope') or 'screen', 'exp': now + 600}
            return self.auth_page(rid)
        if path == '/oauth/deny':
            p = PENDING.pop((q.get('rid') or [''])[0], None)
            if not p:
                return self.page(400, '<p style="font:15px sans-serif;padding:40px">过期了。</p>')
            return self.redirect(p['redirect_uri'] + ('&' if '?' in p['redirect_uri'] else '?') +
                                 urllib.parse.urlencode({'error': 'access_denied', 'state': p['state']}))
        return self.send(404)

    def oauth_post(self, path):
        if path == '/oauth/register':
            try:
                b = json.loads(self.body() or b'{}')
            except Exception:
                return self.send(400, {'error': 'invalid_client_metadata'})
            uris = [u for u in (b.get('redirect_uris') or []) if isinstance(u, str)]
            if not uris or len(uris) > 5 or any(not (u.startswith('https://') or u.startswith('http://localhost') or u.startswith('http://127.0.0.1')) for u in uris):
                return self.send(400, {'error': 'invalid_redirect_uri'})
            cid = 'c_' + secrets.token_urlsafe(16)
            with LOCK:
                d = load_oauth()
                if len(d['clients']) >= 60:   # 不让人拿注册把这本账撑大：留最近的
                    for k in sorted(d['clients'], key=lambda k: d['clients'][k]['at'])[:20]:
                        del d['clients'][k]
                d['clients'][cid] = {'redirect_uris': uris, 'client_name': str(b.get('client_name') or '')[:60], 'at': int(time.time())}
                save_oauth(d)
            log('calls.jsonl', {'t': time.strftime('%H:%M:%S'), 'oauth': 'register', 'name': b.get('client_name'), 'ua': self.headers.get('User-Agent', '')[:60]})
            return self.send(201, {'client_id': cid, 'client_id_issued_at': int(time.time()), 'redirect_uris': uris,
                                   'client_name': b.get('client_name') or '', 'token_endpoint_auth_method': 'none',
                                   'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code']})
        if path == '/oauth/authorize':
            f = urllib.parse.parse_qs(self.body().decode('utf-8', 'replace'))
            rid, code = (f.get('rid') or [''])[0], ''.join(ch for ch in (f.get('code') or [''])[0] if ch.isdigit())
            p = PENDING.get(rid)
            if not p or p['exp'] < time.time():
                return self.page(400, '<p style="font:15px sans-serif;padding:40px">这一页过期了，回聊天应用里重新连一次。</p>')
            if len(code) != 6:
                return self.auth_page(rid, '是六位数')
            st, o = home('/api/agent/remotepair', {'code': code, 'client': p['client_name']}, timeout=15)
            if st != 200:
                return self.auth_page(rid, o.get('error') or ('家里没回音（%s）' % st))
            PENDING.pop(rid, None)
            ac = secrets.token_urlsafe(32)
            CODES[sha(ac)] = {**p, 'exp': time.time() + 300}
            log('calls.jsonl', {'t': time.strftime('%H:%M:%S'), 'oauth': 'granted', 'name': p['client_name']})
            return self.redirect(p['redirect_uri'] + ('&' if '?' in p['redirect_uri'] else '?') +
                                 urllib.parse.urlencode({'code': ac, 'state': p['state'], 'iss': ISSUER}))
        if path == '/oauth/token':
            f = urllib.parse.parse_qs(self.body().decode('utf-8', 'replace'))
            g = lambda k: (f.get(k) or [''])[0]
            bad = lambda e='invalid_grant': self.send(400, {'error': e})
            if g('grant_type') == 'authorization_code':
                c = CODES.pop(sha(g('code')), None)
                if not c or c['exp'] < time.time():
                    return bad()
                if g('client_id') and g('client_id') != c['client_id']:
                    return bad()
                if g('redirect_uri') and g('redirect_uri') != c['redirect_uri']:
                    return bad()
                if b64url(hashlib.sha256(g('code_verifier').encode()).digest()) != c['challenge']:
                    return bad()
                with LOCK:
                    d = load_oauth()
                    out = issue_tokens(d, c['client_id'])
                    save_oauth(d)
                return self.send(200, out)
            if g('grant_type') == 'refresh_token':
                with LOCK:
                    d = load_oauth()
                    t = d['tokens'].pop(sha(g('refresh_token')), None)
                    if not t or t['kind'] != 'refresh' or t['exp'] < time.time() or (g('client_id') and g('client_id') != t['client']):
                        return bad()
                    out = issue_tokens(d, t['client'])
                    save_oauth(d)
                return self.send(200, out)
            return bad('unsupported_grant_type')
        return self.send(404)

    def do_POST(self):
        path = self.path.split('?')[0]
        if path.startswith('/oauth/'):
            return self.oauth_post(path)
        if path.rstrip('/') != PATH:
            return self.send(404)
        if not bearer_ok(self.headers.get('Authorization')):
            log('calls.jsonl', {'t': time.strftime('%H:%M:%S'), 'unauth': True, 'ua': self.headers.get('User-Agent', '')[:60]})
            return self.unauthorized()
        try:
            msg = json.loads(self.body())
        except Exception:
            return self.send(400, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})
        ua = self.headers.get('User-Agent', '')
        if isinstance(msg, list):
            out = [x for x in (handle(m, ua) for m in msg) if x]
            return self.send(200, out) if out else self.send(202)
        out = handle(msg, ua)
        return self.send(200, out) if out else self.send(202)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path.startswith('/.well-known/') or u.path.startswith('/oauth/'):
            return self.oauth_get(u.path, urllib.parse.parse_qs(u.query))
        self.send_response(405)
        self.send_header('Allow', 'POST')
        self.send_header('Content-Length', '0')
        self.end_headers()

    do_DELETE = do_GET


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 39271), H).serve_forever()

// Local integration patch for OpenCLI 2.0.2. Every extension dispatch acquires a
// screen lease, including raw CLI/adapter calls. Unknown outcomes keep the lease
// unresolved: the phone must not be told that the computer has already stopped.
export async function screenRequest(route, body, request = fetch) {
  const r = await request('http://127.0.0.1:5260/agent/oc/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2500),
  });
  if (!r.ok) { const error = new Error('Screen control unavailable or held (' + r.status + ')'); error.status = r.status; throw error; }
  return r.json();
}
export async function acquireScreen(body, request) {
  const lease = await screenRequest('acquire', { id: body.id, turnId: body.screenTurnId || '' }, request);
  if (!lease.token) throw new Error('Screen lease missing');
  return lease.token;
}
export async function releaseScreen(token, uncertain = false, request) {
  return screenRequest('release', { token, uncertain }, request);
}
// 上回结果不确定但当时没报上去（小程序不在）：补报，小程序停手，等人按「还给你」
export async function reportUncertain(request) {
  return screenRequest('uncertain', {}, request);
}

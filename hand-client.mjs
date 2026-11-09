import { spawn } from 'node:child_process';

// A timeout retires the whole protocol generation. Never replay an input whose
// outcome is unknown, or allow an old child's stdout to satisfy a new request.
export class HandClient {
  constructor(exe, { spawnChild = spawn, note = () => {}, fault = () => {}, timeout = 15000 } = {}) {
    Object.assign(this, { exe, spawnChild, note, fault, timeout });
    this.pending = []; this.current = null; this.child = null;
    this.buffer = Buffer.alloc(0); this.generation = 0; this.stopped = false;
    this.retiring = false; this.restart = null;
  }
  start() {
    if (this.stopped || this.child || this.retiring) return;
    const generation = ++this.generation;
    const child = this.spawnChild(this.exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child; this.buffer = Buffer.alloc(0);
    child.stdout.on('data', data => {
      if (child !== this.child || generation !== this.generation || this.retiring) return;
      this.buffer = Buffer.concat([this.buffer, data]); this.pump();
    });
    child.stdin.on('error', error => this.fail(child, error));
    child.on('error', error => this.fail(child, error));
    child.on('exit', code => {
      if (child !== this.child) return;
      this.fail(child, new Error('hand exited ' + code), true);
    });
    this.run();
  }
  get busyMutation() { return this.retiring || !!this.current?.mutation; }
  ask(args, { validate, mutation = false, priority = 1 } = {}) {
    if (this.stopped || this.retiring || !this.child) return Promise.reject(new Error('hand unavailable'));
    if (this.pending.length >= 32) return Promise.reject(new Error('hand queue full'));
    return new Promise((resolve, reject) => {
      const entry = { args, validate, mutation, priority, resolve, reject, generation: this.generation };
      entry.timer = setTimeout(() => {
        if (this.current === entry) this.fail(this.child, new Error('hand timeout'));
        else { this.pending = this.pending.filter(p => p !== entry); reject(new Error('hand queue timeout')); }
      }, this.timeout);
      this.pending.push(entry); this.pending.sort((a, b) => a.priority - b.priority);
      this.run();
    });
  }
  run() {
    if (this.current || !this.child || this.retiring) return;
    while (this.pending.length) {
      const entry = this.pending.shift();
      try {
        if (entry.generation !== this.generation) throw new Error('retired hand request');
        entry.validate?.(); // Last check, immediately before the synchronous write.
        this.current = entry;
        this.child.stdin.write(entry.args.map(a => String(a).replace(/[\t\n\r]/g, ' ')).join('\t') + '\n');
        return;
      } catch (error) {
        if (this.current === entry) { this.fail(this.child, error); return; }
        clearTimeout(entry.timer); entry.reject(error);
      }
    }
  }
  pump() {
    const nl = this.buffer.indexOf(10), entry = this.current;
    if (!entry || nl < 0) return;
    const head = this.buffer.subarray(0, nl).toString('utf8').trimEnd().split('\t');
    let end = nl + 1, body;
    if (head[0] === 'JPEG') {
      const length = Number(head[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024) {
        this.fail(this.child, new Error('invalid hand frame')); return;
      }
      end += length; if (this.buffer.length < end) return;
      body = Buffer.from(this.buffer.subarray(nl + 1, end));
    }
    this.buffer = this.buffer.subarray(end); this.current = null;
    clearTimeout(entry.timer);
    if (head[0] === 'ERR') entry.reject(new Error(head.slice(1).join(' ')));
    else entry.resolve({ head, body });
    this.run();
  }
  fail(child, error, exited = false) {
    if (!child || child !== this.child) return;
    if (!this.retiring) {
      this.retiring = true; this.fault(error); this.note({ ev: 'hand-fault', msg: error.message });
      for (const p of [this.current, ...this.pending].filter(Boolean)) { clearTimeout(p.timer); p.reject(error); }
      this.current = null; this.pending = []; this.buffer = Buffer.alloc(0);
    }
    if (!exited && child.pid) { try { child.kill(); } catch {} return; }
    this.child = null; this.retiring = false;
    if (!this.stopped) this.restart = setTimeout(() => this.start(), 500);
  }
  close() {
    this.stopped = true; clearTimeout(this.restart);
    if (this.child) this.fail(this.child, new Error('hand closed'));
  }
}

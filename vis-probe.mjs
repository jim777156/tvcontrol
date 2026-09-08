import CDP from 'chrome-remote-interface';
const targets = await CDP.List({ host: '127.0.0.1', port: 9222 });
const pages = targets.filter(t => t.type === 'page');
for (const t of pages) {
  let c;
  try {
    c = await CDP({ host: '127.0.0.1', port: 9222, target: t.id });
    const { result } = await c.Runtime.evaluate({
      expression: '({vis: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(), title: document.title.slice(0,50)})',
      returnByValue: true,
    });
    console.log(JSON.stringify(result.value));
  } catch (e) { console.log('ERR', t.id.slice(0,8), e.message); }
  finally { if (c) await c.close(); }
}

// /netlify/functions/hello.js
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, msg: 'hello from Netlify Functions' })
  };
};

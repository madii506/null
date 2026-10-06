// Temporary: brand art for NPC through the Vercel AI Gateway (FLUX). Cached on the CDN per (shot, v).
const CH = 'a cute stylized 3D video game NPC villager: a young man with short messy chestnut-brown hair, a round friendly face, small glossy black bead eyes, faint rosy cheeks, a tiny neutral smile, a plain white crew-neck t-shirt, slightly faded blue jeans and chunky brown sneakers, standing perfectly still in a stiff idle pose with both arms straight down at his sides, facing the camera straight on, a glowing golden-yellow exclamation mark floating just above his head';
const STYLE = 'soft clay-like 3D render, cozy indie video game art style, smooth matte materials, gentle global illumination, crisp details, high quality, no text, no letters, no logo';
const P = {
  pfp: `${CH}. Full body, centered, small in the middle of the frame with lots of empty space around him, plain soft dusk-purple gradient studio background, subtle floor shadow, gentle warm rim light. ${STYLE}`,
  pfp2: `16-bit style high-detail pixel art of ${CH}. Full body, centered, small in the middle of the frame with lots of empty space, plain deep purple background, crisp pixels, limited palette, no text`,
  banner: `a wide cinematic shot of a quiet cozy video game town street at dusk, purple and peach sky, warm glowing shop windows and string lights, a row of eight different stylized 3D NPC villagers standing side by side facing the camera, all frozen in stiff identical idle poses with blank friendly faces, varied hair and clothes; the villager in the exact center is ${CH}; one villager on the right stands in a stiff T-pose with both arms straight out to the sides. ${STYLE}`,
};
const SIZE = { pfp: '1024x1024', pfp2: '1024x1024', banner: '1536x512' };
module.exports = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const shot = u.searchParams.get('shot') || 'pfp'; const v = u.searchParams.get('v') || '1';
    if (!P[shot] || !/^[1-8]$/.test(v)) { res.statusCode = 404; return res.end('no'); }
    const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || req.headers['x-vercel-oidc-token'];
    const body = { model: u.searchParams.get('m') === 'g' ? 'google/imagen-4.0-ultra-generate-001' : 'bfl/flux-2-pro', prompt: P[shot], n: 1, size: SIZE[shot] };
    const r = await fetch('https://ai-gateway.vercel.sh/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (!r.ok) { res.statusCode = 502; res.setHeader('Content-Type', 'text/plain'); return res.end('gateway ' + r.status + ': ' + txt.slice(0, 600)); }
    const j = JSON.parse(txt); const d = j.data && j.data[0];
    if (!d) { res.statusCode = 502; return res.end('no image: ' + txt.slice(0, 300)); }
    let buf;
    if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
    else if (d.url) buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
    res.setHeader('Content-Type', buf[0] === 0xff ? 'image/jpeg' : 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    res.end(buf);
  } catch (e) { res.statusCode = 500; res.end('err ' + String(e && e.message || e)); }
};

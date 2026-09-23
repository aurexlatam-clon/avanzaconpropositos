// /api/notify-make.js
// Función server-side de Vercel. Recibe el lead validado desde el navegador
// y lo reenvía al webhook de Make, usando las credenciales que SOLO existen
// como variables de entorno privadas en Vercel (nunca en el código ni en el
// navegador). MAKE_WEBHOOK_URL y MAKE_API_KEY no se exponen en ninguna
// respuesta, log ni en este archivo.

const ALLOWED_FIELDS = [
  'lead_id',
  'funnel_id',
  'event_type',
  'first_name',
  'last_name',
  'email',
  'phone',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'landing_page_url',
  // Funnel webinario (lime-webinar)
  'webinar_date',
  'webinar_label',
  'guia_url'
];

const MAX_LEN = 300;

function sanitizeString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  // Quita caracteres de control y recorta longitud para evitar payloads abusivos.
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, MAX_LEN);
}

function isValidEmail(value) {
  if (!value) return true; // el campo es opcional; si viene vacío, se acepta vacío
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidLeadId(value) {
  // Formato que genera nuestro propio snippet: lead_<base36>_<random>
  return /^[A-Za-z0-9_-]{5,80}$/.test(value);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }

  // Solo aceptamos exactamente los campos declarados — cualquier otro se descarta.
  const clean = {};
  for (const field of ALLOWED_FIELDS) {
    clean[field] = sanitizeString(body[field]);
  }

  if (!clean.lead_id || !isValidLeadId(clean.lead_id)) {
    return res.status(400).json({ ok: false, error: 'invalid_lead_id' });
  }
  if (!isValidEmail(clean.email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  const apiKey = process.env.MAKE_API_KEY;

  if (!webhookUrl || !apiKey) {
    console.error('notify-make: faltan variables de entorno MAKE_WEBHOOK_URL / MAKE_API_KEY');
    // No revelamos detalles del error al cliente.
    return res.status(500).json({ ok: false, error: 'server_not_configured' });
  }

  // Tiempo de espera controlado: si Make no responde, no dejamos la función colgada.
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 8000);

  try {
    const makeResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-make-apikey': apiKey
      },
      body: JSON.stringify(clean),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!makeResponse.ok) {
      console.error('notify-make: respuesta no exitosa de Make', makeResponse.status);
      // El registro YA está guardado en Firebase de forma independiente;
      // un fallo aquí no lo afecta. Solo informamos que el aviso a Make falló.
      return res.status(502).json({ ok: false, error: 'make_upstream_error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    clearTimeout(timeout);
    console.error('notify-make: error de red o timeout', err.message);
    return res.status(504).json({ ok: false, error: 'make_unreachable' });
  }
};

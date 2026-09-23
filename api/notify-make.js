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
  'guia_url',
  'wa_code'
];

const MAX_LEN = 300;

function sanitizeString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  // Quita caracteres de control y recorta longitud para evitar payloads abusivos.
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, MAX_LEN);
}

// Misma regla que el formulario (index.html). Estricta a propósito: un correo
// mal escrito que llegue a HubSpot puede detener el escenario de Make.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const TLD_TYPOS = ['con', 'cmo', 'comm', 'coom', 'vom', 'xom', 'cpm', 'ocm'];

function isValidEmail(value) {
  if (!value || value.length > 120) return false;
  if (!EMAIL_RE.test(value) || value.indexOf('..') !== -1) return false;
  const [local, domain] = value.split('@');
  if (local.startsWith('.') || local.endsWith('.')) return false;
  const tld = domain.split('.').pop();
  return !TLD_TYPOS.includes(tld);
}

// Eventos de REGISTRO: son los únicos que exigen correo válido.
// '' = registro del funnel original (no manda event_type).
// Eventos posteriores (video_progress, quiz_completed, etc.) no se bloquean.
const REGISTRATION_EVENTS = ['', 'registro', 'webinar_registro'];

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
  clean.email = clean.email.toLowerCase();
  const requiresEmail = REGISTRATION_EVENTS.includes(clean.event_type);

  if (requiresEmail) {
    if (!isValidEmail(clean.email)) {
      // Se rechaza SIN llamar al webhook: Make/HubSpot nunca reciben el dato malo.
      return res.status(400).json({
        ok: false,
        error: 'invalid_email',
        message: 'Correo electrónico inválido. El registro no se envió a Make.'
      });
    }
  } else if (clean.email && !isValidEmail(clean.email)) {
    // Evento posterior con un correo malo: no se bloquea el evento,
    // solo no se reenvía ese correo a Make.
    clean.email = '';
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

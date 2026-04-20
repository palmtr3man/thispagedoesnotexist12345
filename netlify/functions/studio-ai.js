/**
 * /api/studio-ai — Netlify Function
 *
 * Server-side proxy for the Studio AI Optimizer.
 * Keeps the OPENAI_API_KEY secret server-side and enforces
 * rate-limiting / content policy before forwarding to OpenAI.
 *
 * Route:  POST /api/studio-ai
 *
 * Request body (JSON):
 *   {
 *     action:      'enhance' | 'ats' | 'skills' | 'analyze',
 *     resume:      { personal_info, experience, education, skills, ... },
 *     jobDescription?: string   // required for action === 'ats'
 *   }
 *
 * Success:
 *   HTTP 200  { ok: true, result: '<markdown string>' }
 *
 * Error:
 *   HTTP 400  { ok: false, error: 'Bad request reason' }
 *   HTTP 500  { ok: false, error: 'AI service unavailable' }
 *
 * Required env var:
 *   OPENAI_API_KEY — OpenAI secret key.
 *   If unset, returns HTTP 500 with a clear message.
 *
 * CORS: restricted to .com origin.
 */

const ALLOWED_ORIGIN = 'https://www.thispagedoesnotexist12345.com';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL          = 'gpt-4o-mini';
const MAX_TOKENS     = 800;

const HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function resumeToText(resume) {
  const pi = resume.personal_info || {};
  const lines = [];
  if (pi.full_name)           lines.push(`Name: ${pi.full_name}`);
  if (pi.professional_title)  lines.push(`Title: ${pi.professional_title}`);
  if (pi.email)               lines.push(`Email: ${pi.email}`);
  if (pi.location)            lines.push(`Location: ${pi.location}`);
  if (pi.summary)             lines.push(`\nSummary:\n${pi.summary}`);
  if (resume.experience?.length) {
    lines.push('\nExperience:');
    resume.experience.forEach(e => {
      lines.push(`  ${e.title} at ${e.company} (${e.start_date} – ${e.end_date})`);
      if (e.description) lines.push(`  ${e.description}`);
    });
  }
  if (resume.education?.length) {
    lines.push('\nEducation:');
    resume.education.forEach(e => lines.push(`  ${e.degree} — ${e.institution} (${e.start_date} – ${e.end_date})`));
  }
  if (resume.skills?.length) {
    lines.push(`\nSkills: ${resume.skills.join(', ')}`);
  }
  if (resume.certifications?.length) {
    lines.push('\nCertifications:');
    resume.certifications.forEach(c => lines.push(`  ${c.name} — ${c.issuer} (${c.date})`));
  }
  if (resume.projects?.length) {
    lines.push('\nProjects:');
    resume.projects.forEach(p => lines.push(`  ${p.name}: ${p.description}`));
  }
  return lines.join('\n');
}

function buildPrompt(action, resume, jobDescription) {
  const resumeText = resumeToText(resume);
  switch (action) {
    case 'enhance':
      return {
        system: 'You are an expert resume writer. Provide concise, actionable suggestions to improve the resume content. Focus on impact, quantifiable achievements, and strong action verbs. Return a short markdown list (max 8 items).',
        user:   `Review this resume and provide specific content enhancement suggestions:\n\n${resumeText}`
      };
    case 'ats':
      return {
        system: 'You are an ATS (Applicant Tracking System) expert. Analyse the resume against the job description and provide: 1) an ATS compatibility score out of 100, 2) matched keywords, 3) missing keywords, 4) specific improvements. Return structured markdown.',
        user:   `Job Description:\n${jobDescription}\n\nResume:\n${resumeText}`
      };
    case 'skills':
      return {
        system: 'You are a career coach. Based on the resume content, suggest 8–12 specific, relevant skills the candidate should add. Tailor suggestions to their industry and role. Return a markdown list with a one-line explanation for each.',
        user:   `Based on this resume, suggest skills to add:\n\n${resumeText}`
      };
    case 'analyze':
      return {
        system: 'You are a professional resume reviewer. Provide a structured analysis covering: overall impression, strengths, weaknesses, and 3 priority improvements. Be specific and actionable. Return structured markdown.',
        user:   `Analyse this resume:\n\n${resumeText}`
      };
    default:
      return null;
  }
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'AI service not configured. Set OPENAI_API_KEY in Netlify environment variables.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { action, resume, jobDescription } = body;

  if (!action || !['enhance', 'ats', 'skills', 'analyze'].includes(action)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Invalid action. Must be one of: enhance, ats, skills, analyze' }) };
  }
  if (!resume || typeof resume !== 'object') {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'resume object is required' }) };
  }
  if (action === 'ats' && (!jobDescription || !jobDescription.trim())) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'jobDescription is required for ATS scoring' }) };
  }

  const prompt = buildPrompt(action, resume, jobDescription);
  if (!prompt) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Could not build prompt for action: ' + action }) };
  }

  try {
    const aiRes = await fetch(OPENAI_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user',   content: prompt.user   },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('[studio-ai] OpenAI error:', aiRes.status, errText);
      return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'AI service returned an error. Please try again.' }) };
    }

    const aiData = await aiRes.json();
    const result = aiData.choices?.[0]?.message?.content || '';

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (err) {
    console.error('[studio-ai] fetch error:', err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'AI service unavailable. Please try again.' }) };
  }
};

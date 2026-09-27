/**
 * Vercel serverless endpoint for browser-safe Supabase configuration.
 *
 * SUPABASE_PUBLISHABLE_KEY is intended for browser use. Do not add a
 * SUPABASE_SERVICE_ROLE_KEY here or to any client-side configuration.
 */
module.exports = (_request, response) => {
  const config = {
    url: process.env.SUPABASE_URL || '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ''
  };

  response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.status(200).send(`window.SUPABASE_CONFIG = ${JSON.stringify(config)};`);
};

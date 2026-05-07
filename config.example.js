module.exports = {
  PORT: 8888,                            // standard AI/Jupyter port — easy to remember
  HTTPS_PORT: 8889,                      // HTTPS port for ai-services
  OLLAMA_HOST: 'http://localhost:11434', // or http://192.168.1.2:11434 for LAN access
  SERPER_API_KEY: 'YOUR_SERPER_KEY',     // get free key at serper.dev (2500/month free)
  GOOGLE_CX: 'YOUR_GOOGLE_CX',          // Google Custom Search engine ID
  GOOGLE_API_KEY: '',                    // optional — leave blank to use Serper only
};

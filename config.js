// Public settings for the website. Everything here is safe to publish:
// the Supabase anon key only allows what the database's row-level security rules allow.
window.SHELF_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  // Apps Script web app (server jobs: BGG search for the Add page, price refresh, sheet sync)
  JOBS_URL: 'https://script.google.com/macros/s/AKfycbz7jexEHfkDSTTCScOeujb9hk0FvtiE6b6rsxJeRMyKoiFNOjnxXjvuHlBBmnctUfVc4g/exec',
  SITE_URL: 'https://thesakshipandey.github.io/boardgame/',
  TITLE: 'The Game Shelf'
};

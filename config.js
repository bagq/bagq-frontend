// =============================================
// SUPABASE CONFIGURATION
// =============================================
// Replace these with your actual Supabase credentials

const SUPABASE_CONFIG = {
  url: "https://jiypktabinncpbhoulte.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppeXBrdGFiaW5uY3BiaG91bHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTA4NjgsImV4cCI6MjA4ODI4Njg2OH0.Pty4CL9Tfw5afYhQ0JfOrF2UyYj4JYyRBLrndk0cTvk"
};

// API endpoint (for production, change to your deployed URL)
const API_BASE_URL = "http://localhost:3000/api";

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPABASE_CONFIG, API_BASE_URL };
}

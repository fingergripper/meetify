import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const supabaseConfigError = !url || !key
  ? 'Add your Supabase URL and browser-safe publishable key to .env.local.'
  : key.startsWith('sb_secret_')
    ? 'The configured Supabase key is a secret server key. Replace it with the browser-safe publishable or anon key.'
    : null
export const supabase = url && key && !supabaseConfigError ? createClient(url, key) : null

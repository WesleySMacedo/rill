import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const supabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase = supabaseConfigured
	? createClient(supabaseUrl!, supabasePublishableKey!, {
			auth: {
				flowType: "pkce",
				persistSession: true,
				autoRefreshToken: true,
				detectSessionInUrl: true,
			},
		})
	: null;
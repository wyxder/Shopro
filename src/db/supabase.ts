import { createClient } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://backend.appmiaoda.com/projects/supabase313589630060507136";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
export const isSupabaseConfigured = Boolean(supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.error(
    "[Supabase] 环境变量 VITE_SUPABASE_ANON_KEY 未配置，请在 Vercel 项目 Settings → Environment Variables 中设置后重新部署",
  );
}

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey || "missing-supabase-anon-key",
);
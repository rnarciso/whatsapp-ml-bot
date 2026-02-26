export type SessionStatus =
  | 'collecting_photos'
  | 'analyzing'
  | 'awaiting_user_info'
  | 'awaiting_confirmation'
  | 'publishing'
  | 'done'
  | 'cancelled'
  | 'error';

export interface PhotoRef {
  id: string;
  messageId: string;
  mimeType: string;
  filePath: string;
  sha256: string;
  receivedAt: number;
}

export type ItemCondition = 'new' | 'used' | 'refurbished' | 'unknown';

export interface VisionQuestion {
  key: string;
  question: string;
  kind: 'text' | 'choice' | 'boolean';
  options?: string[];
}

export interface VisionProductGuess {
  short_name: string;
  likely_category: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  condition: ItemCondition;
  color: string | null;
  material: string | null;
  quantity: number | null;
  included: string[];
  defects: string[];
  notes: string[];
}

export interface VisionListingDraft {
  title: string;
  title_alternatives: string[];
  description_ptbr: string;
  search_query: string;
  keywords: string[];
}

export interface VisionResult {
  confidence: number;
  product: VisionProductGuess;
  listing: VisionListingDraft;
  questions: VisionQuestion[];
}

export interface ComparableItem {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  permalink?: string;
  condition?: string;
  sold_quantity?: number;
}

export interface PriceAnalysis {
  currency_id: string;
  sample_size: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  suggested_fair: number;
  suggested_fast: number;
  suggested_profit: number;
  comparables: ComparableItem[];
}

export interface ListingDraft {
  title: string;
  category_id: string | null;
  condition: ItemCondition;
  quantity: number;
  currency_id: string;
  price_fair: number | null;
  price_fast: number | null;
  price_chosen: number | null;
  description_ptbr: string;
  attributes: Record<string, { value_name?: string; value_id?: string }>;
}

export interface PublishedItem {
  item_id: string;
  permalink?: string;
  status?: string;
}

export interface Session {
  id: string;
  groupId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  collectUntil?: number;
  photos: PhotoRef[];
  vision?: VisionResult;
  categoryId?: string;
  price?: PriceAnalysis;
  userInput?: Record<string, string>;
  draft?: ListingDraft;
  published?: PublishedItem;
  pendingField?: string;
  lastBotMessageId?: string;
  error?: string;
}

export interface Db {
  sessions: Record<string, Session>;
  settings?: AppSettings;
  mlTokens?: {
    access_token: string;
    refresh_token: string;
    expires_at_ms: number;
  };
  mlTokensEncrypted?: string;
}

export interface AppSettings {
  // OpenAI/OpenAI-compatible
  openai_base_url: string;
  openai_api_key: string;
  openai_model_vision: string;
  openai_model_vision_fallback: string;

  // Mercado Livre
  ml_site_id: string;
  ml_client_id: string;
  ml_client_secret: string;
  ml_refresh_token: string;
  ml_currency_id: string;
  ml_listing_type_id: string;
  ml_buying_mode: string;
  ml_default_quantity: number;
  ml_dry_run: boolean;

  // WhatsApp flow/safety
  require_command_for_images: boolean;
  conversation_mode: 'guided' | 'kv';
  session_scope: 'group' | 'user';
  photo_collect_window_sec: number;
  max_image_bytes: number;
  max_photos_per_session: number;
  wa_human_delay_ms_min: number;
  wa_human_delay_ms_max: number;
  wa_send_interval_ms: number;
  wa_send_interval_cap: number;

  // Cleanup/retention
  media_retention_hours: number;
  session_inactive_hours: number;
  session_retention_days: number;
  cleanup_interval_min: number;
}

import { createClient } from "@supabase/supabase-js";

const BUCKET = "wine-images";

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured in .env");
  }
  return createClient(url, key);
}

async function ensureBucket(): Promise<void> {
  const client = getClient();
  const { data: buckets } = await client.storage.listBuckets();
  if (buckets?.some((b) => b.name === BUCKET)) return;

  const { error } = await client.storage.createBucket(BUCKET, { public: true });
  if (error) throw error;
}

/** Uploads a company's wine photo to Supabase Storage and returns its public
 * URL. `upsert: true` so re-uploading the same wine's photo overwrites the
 * old file instead of accumulating orphaned images. */
export async function uploadWineImage(
  filename: string,
  fileBuffer: Buffer,
  contentType: string
): Promise<string> {
  await ensureBucket();
  const client = getClient();

  const { error } = await client.storage
    .from(BUCKET)
    .upload(filename, fileBuffer, { contentType, upsert: true });
  if (error) throw error;

  const { data } = client.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

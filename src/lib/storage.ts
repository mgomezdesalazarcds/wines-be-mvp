import { createClient } from "@supabase/supabase-js";

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured in .env");
  }
  return createClient(url, key);
}

async function ensureBucket(bucket: string): Promise<void> {
  const client = getClient();
  const { data: buckets } = await client.storage.listBuckets();
  if (buckets?.some((b) => b.name === bucket)) return;

  const { error } = await client.storage.createBucket(bucket, { public: true });
  if (error) throw error;
}

/** Uploads a file to a public Supabase Storage bucket and returns its public
 * URL. `upsert: true` so re-uploading the same filename overwrites the old
 * file instead of accumulating orphans. */
async function uploadFile(
  bucket: string,
  filename: string,
  fileBuffer: Buffer,
  contentType: string
): Promise<string> {
  await ensureBucket(bucket);
  const client = getClient();

  const { error } = await client.storage
    .from(bucket)
    .upload(filename, fileBuffer, { contentType, upsert: true });
  if (error) throw error;

  const { data } = client.storage.from(bucket).getPublicUrl(filename);
  return data.publicUrl;
}

export function uploadWineImage(
  filename: string,
  fileBuffer: Buffer,
  contentType: string
): Promise<string> {
  return uploadFile("wine-images", filename, fileBuffer, contentType);
}

export function uploadCompanyLogo(
  filename: string,
  fileBuffer: Buffer,
  contentType: string
): Promise<string> {
  return uploadFile("company-logos", filename, fileBuffer, contentType);
}

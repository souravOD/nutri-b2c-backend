import pg from "postgres";
const sql = pg(process.env.DATABASE_URL);
const r = await sql.unsafe("SELECT COUNT(*) as total, COUNT(image_url) as with_image FROM gold.recipes");
console.log("Stats:", JSON.stringify(r));
const s = await sql.unsafe("SELECT id, title, image_url FROM gold.recipes LIMIT 5");
console.log("Sample:", JSON.stringify(s));
await sql.end();

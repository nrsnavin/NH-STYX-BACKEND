import Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { composeStoreProduct } from '../products/product.service';

export interface AiSearchFilters {
  keywords: string[];
  categorySlug: string | null;
  maxPricePaise: number | null;
  minQty: number | null;
}

interface Interpretation {
  filters: AiSearchFilters;
  reply: string;
  aiPowered: boolean;
}

type ComposedProduct = ReturnType<typeof composeStoreProduct>;

const STOPWORDS = new Set([
  'show', 'me', 'all', 'the', 'a', 'an', 'for', 'with', 'in', 'of', 'and', 'to',
  'under', 'below', 'less', 'than', 'rs', 'rupees', 'price', 'priced', 'cost',
  'need', 'want', 'looking', 'find', 'buy', 'some', 'any', 'good', 'best',
]);

/** Pull the first JSON object out of an LLM response (tolerates ```json fences). */
function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in AI response');
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

/**
 * Cheap, no-LLM interpretation of the query into retrieval filters (price,
 * category, keywords). Used to build the candidate pool — the LLM does the
 * actual recommending on top of these candidates.
 */
function heuristicInterpret(query: string, categories: { name: string; slug: string }[]): Interpretation {
  const lower = query.toLowerCase();

  // Price intent: "under 300", "below ₹300", "less than 300"
  let maxPricePaise: number | null = null;
  const priceMatch = lower.match(/(?:under|below|less than|upto|up to)\s*₹?\s*(\d+)/);
  if (priceMatch) {
    maxPricePaise = parseInt(priceMatch[1], 10) * 100;
  }

  // Category intent: a category name/slug word appears in the query.
  let categorySlug: string | null = null;
  let categoryWords = '';
  for (const c of categories) {
    const name = c.name.toLowerCase();
    if (lower.includes(name) || lower.includes(c.slug.replace(/-/g, ' '))) {
      categorySlug = c.slug;
      categoryWords = `${name} ${c.slug.replace(/-/g, ' ')}`;
      break;
    }
  }

  // Strip a trailing plural 's' so "kurtis"/"hangers" match singular product names.
  const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

  const keywords = lower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .filter((w) => !categoryWords.includes(w))
    .map(stem);

  return {
    filters: { keywords, categorySlug, maxPricePaise, minQty: null },
    reply: `Showing results for “${query}”.`,
    aiPowered: false,
  };
}

interface Recommendation {
  indices: number[];
  reply: string;
}

/**
 * Grounded recommendation: Claude sees a numbered slice of THIS store's live
 * catalog and returns the catalog numbers it recommends (best first) plus a
 * short explanation. It can only pick from the provided products, so it never
 * invents items the store doesn't stock.
 */
async function recommendProducts(query: string, candidates: ComposedProduct[]): Promise<Recommendation> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const catalog = candidates
    .map((p, i) => {
      const price = `₹${Math.round(p.pricePaise / 100)}`;
      const brand = p.brand ? ` | ${p.brand}` : '';
      const cat = p.categoryName ? ` | ${p.categoryName}` : '';
      const tags = p.tags && p.tags.length ? ` | tags: ${p.tags.join(', ')}` : '';
      const stock = p.inStock ? '' : ' | OUT OF STOCK';
      return `[${i + 1}] ${p.name}${brand}${cat} | ${price}/${p.unit.toLowerCase()}${tags}${stock}`;
    })
    .join('\n');

  const system = [
    'You are a knowledgeable sales assistant for NH Styx, a B2B wholesale',
    'marketplace for garment store and boutique owners (apparel + store supplies).',
    "You recommend products from THIS store's live catalog (provided by the user)",
    "based on the shopper's request — weighing use-case, occasion, fabric/material,",
    'budget, minimum order quantity and complementary items (cross-sells).',
    'Rules:',
    '- Only recommend products from the numbered catalog. NEVER invent products.',
    '- Prefer in-stock items; put the best matches first and omit irrelevant ones.',
    '- If nothing fits, return an empty list and say so kindly.',
    'Respond with ONLY a JSON object (no markdown, no prose):',
    '{"indices": number[], "reply": string}.',
    '"indices" are the catalog numbers you recommend, best first (max 12).',
    '"reply" is one or two friendly sentences explaining the picks.',
  ].join(' ');

  const user = `Shopper request: "${query}"\n\nStore catalog:\n${catalog}`;

  const response = await client.messages.create({
    model: env.AI_SEARCH_MODEL,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Empty AI response');

  const parsed = extractJson<{ indices?: unknown; reply?: unknown }>(text.text);
  const indices = Array.isArray(parsed.indices)
    ? parsed.indices.filter(
        (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= candidates.length,
      )
    : [];
  const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
    ? parsed.reply.trim()
    : `Here are some picks for “${query}”.`;
  return { indices, reply };
}

/** Builds the candidate pool. `matched` is the precise filter result (shown
 *  as-is when there's no LLM); `candidates` adds well-stocked staples so the
 *  assistant always has enough to recommend from for vague queries. */
async function retrieveCandidates(
  storeId: string,
  filters: AiSearchFilters,
): Promise<{ matched: ComposedProduct[]; candidates: ComposedProduct[] }> {
  const { keywords, categorySlug, maxPricePaise } = filters;

  const productWhere: Prisma.ProductWhereInput = { isActive: true };
  if (categorySlug) {
    const category = await prisma.category.findUnique({
      where: { slug: categorySlug },
      include: { children: { select: { id: true } } },
    });
    if (category) {
      productWhere.categoryId = { in: [category.id, ...category.children.map((c) => c.id)] };
    }
  }
  if (keywords.length) {
    productWhere.OR = [
      ...keywords.flatMap((k) => [
        { name: { contains: k, mode: Prisma.QueryMode.insensitive } },
        { brand: { contains: k, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: k, mode: Prisma.QueryMode.insensitive } },
      ]),
      { tags: { hasSome: keywords.map((k) => k.toLowerCase()) } },
    ];
  }

  const include = {
    product: { include: { category: true, variants: { where: { isActive: true } } } },
    priceTiers: true,
  } as const;

  const matchedRows = await prisma.storeProduct.findMany({
    where: {
      storeId,
      isActive: true,
      product: productWhere,
      ...(maxPricePaise ? { pricePaise: { lte: maxPricePaise } } : {}),
    },
    include,
    take: 40,
    orderBy: { createdAt: 'desc' },
  });

  const matched = matchedRows.map((sp) => composeStoreProduct(sp));
  const candidates = [...matched];

  // Backfill with well-stocked products so vague queries still give the LLM
  // options (the LLM ignores anything irrelevant). Only the LLM sees these —
  // without a key we return `matched` untouched.
  if (candidates.length < 15) {
    const seen = new Set(candidates.map((c) => c.id));
    const fill = await prisma.storeProduct.findMany({
      where: { storeId, isActive: true, product: { isActive: true } },
      include,
      take: 20,
      orderBy: [{ stockQty: 'desc' }],
    });
    for (const row of fill) {
      if (seen.has(row.productId)) continue;
      candidates.push(composeStoreProduct(row));
      seen.add(row.productId);
      if (candidates.length >= 20) break;
    }
  }

  return { matched, candidates: candidates.slice(0, 50) };
}

/**
 * Store-scoped natural-language search + recommendation. Retrieves candidates
 * from the customer's store, then (when an Anthropic key is configured) asks
 * Claude to recommend the best matches for the query. Without a key it returns
 * the filtered candidates directly.
 */
export async function aiSearch(storeId: string, query: string) {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, name: true, slug: true, imageUrl: true },
  });

  const interpretation = heuristicInterpret(query, categories);
  const { keywords, categorySlug } = interpretation.filters;

  // Stage 1 — retrieve candidates from the store's live catalog.
  const { matched, candidates } = await retrieveCandidates(storeId, interpretation.filters);

  // Stage 2 — let the LLM recommend from those candidates (grounded). Without a
  // key (or on failure) we return the precise filter matches.
  let items = matched;
  let reply = interpretation.reply;
  let aiPowered = false;

  if (env.ANTHROPIC_API_KEY && candidates.length) {
    try {
      const rec = await recommendProducts(query, candidates);
      const picked = rec.indices.map((i) => candidates[i - 1]).filter(Boolean);
      items = picked.length ? picked : matched;
      reply = rec.reply;
      aiPowered = true;
    } catch (err) {
      logger.warn({ err }, 'AI recommendation failed — falling back to filtered results');
    }
  }

  // Categories matching the query/keywords, so the UI can offer them as chips.
  const ql = query.toLowerCase();
  const kw = keywords.map((k) => k.toLowerCase());
  const matchedCategories = categories
    .filter((c) => {
      const n = c.name.toLowerCase();
      if (categorySlug && c.slug === categorySlug) return true;
      if (ql.includes(n)) return true;
      return kw.some((k) => n.includes(k) || k.includes(n));
    })
    .slice(0, 8)
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, imageUrl: c.imageUrl ?? null }));

  return {
    reply,
    aiPowered,
    filters: interpretation.filters,
    categories: matchedCategories,
    items,
  };
}

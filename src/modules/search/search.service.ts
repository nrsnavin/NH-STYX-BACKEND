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

const STOPWORDS = new Set([
  'show', 'me', 'all', 'the', 'a', 'an', 'for', 'with', 'in', 'of', 'and', 'to',
  'under', 'below', 'less', 'than', 'rs', 'rupees', 'price', 'priced', 'cost',
  'need', 'want', 'looking', 'find', 'buy', 'some', 'any', 'good', 'best',
]);

/** Keyword fallback used when no Anthropic key is configured (or the call fails). */
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
    // Drop words that the category already covers, so category + keyword aren't
    // redundantly ANDed (e.g. "apparel" shouldn't also be a required keyword).
    .filter((w) => !categoryWords.includes(w))
    .map(stem);

  return {
    filters: { keywords, categorySlug, maxPricePaise, minQty: null },
    reply: `Showing results for “${query}”.`,
    aiPowered: false,
  };
}

/** Uses Claude to turn a natural-language query into structured catalog filters. */
async function aiInterpret(
  query: string,
  categories: { name: string; slug: string }[],
): Promise<Interpretation> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const categoryList = categories.map((c) => `${c.name} (slug: ${c.slug})`).join(', ');

  const system = [
    'You are a product-search assistant for NH Styx, a B2B wholesale marketplace',
    'for garment store and boutique owners (apparel + store supplies).',
    'Convert the shopper\'s natural-language query into catalog filters.',
    'Prices are in paise (₹1 = 100 paise).',
    'Respond with ONLY a JSON object (no markdown, no prose) of the shape:',
    '{"keywords": string[], "categorySlug": string|null, "maxPricePaise": number|null,',
    ' "minQty": number|null, "reply": string}',
    `Valid category slugs: ${categoryList}. Use null if none clearly applies.`,
    '"reply" is a one-sentence friendly summary of what you searched for.',
  ].join(' ');

  const response = await client.messages.create({
    model: env.AI_SEARCH_MODEL,
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: query }],
  });

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new Error('Empty AI response');
  }
  const parsed = JSON.parse(text.text) as Partial<AiSearchFilters> & { reply?: string };

  return {
    filters: {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      categorySlug: parsed.categorySlug ?? null,
      maxPricePaise: typeof parsed.maxPricePaise === 'number' ? parsed.maxPricePaise : null,
      minQty: typeof parsed.minQty === 'number' ? parsed.minQty : null,
    },
    reply: parsed.reply ?? `Showing results for “${query}”.`,
    aiPowered: true,
  };
}

/** Store-scoped natural-language search: results come from the customer's store. */
export async function aiSearch(storeId: string, query: string) {
  const categories = await prisma.category.findMany({ select: { name: true, slug: true } });

  let interpretation: Interpretation;
  if (env.ANTHROPIC_API_KEY) {
    try {
      interpretation = await aiInterpret(query, categories);
    } catch (err) {
      logger.warn({ err }, 'AI search failed — falling back to keyword search');
      interpretation = heuristicInterpret(query, categories);
    }
  } else {
    interpretation = heuristicInterpret(query, categories);
  }

  const { keywords, categorySlug, maxPricePaise } = interpretation.filters;

  // Catalog-side filters (category, keywords).
  const productWhere: Prisma.ProductWhereInput = { isActive: true };
  if (categorySlug) {
    // Match the category and any of its sub-categories (tree-aware).
    const category = await prisma.category.findUnique({
      where: { slug: categorySlug },
      include: { children: { select: { id: true } } },
    });
    if (category) {
      productWhere.categoryId = { in: [category.id, ...category.children.map((c) => c.id)] };
    }
  }
  if (keywords.length) {
    productWhere.OR = keywords.flatMap((k) => [
      { name: { contains: k, mode: Prisma.QueryMode.insensitive } },
      { brand: { contains: k, mode: Prisma.QueryMode.insensitive } },
      { description: { contains: k, mode: Prisma.QueryMode.insensitive } },
    ]);
  }

  // Search only what the customer's store stocks; price filter uses store price.
  const where: Prisma.StoreProductWhereInput = {
    storeId,
    isActive: true,
    product: productWhere,
    ...(maxPricePaise ? { pricePaise: { lte: maxPricePaise } } : {}),
  };

  const rows = await prisma.storeProduct.findMany({
    where,
    include: { product: { include: { category: true } }, priceTiers: true },
    take: 40,
    orderBy: { createdAt: 'desc' },
  });

  return {
    reply: interpretation.reply,
    aiPowered: interpretation.aiPowered,
    filters: interpretation.filters,
    items: rows.map(composeStoreProduct),
  };
}

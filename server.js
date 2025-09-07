const express = require('express');
const axios = require('axios');

// Throttle mechanism is present. HTTP error code 429 (too many requests) is thrown. 
// Trying a workaround. 
// --- 429-aware axios interceptors (reactive only) ---
const penaltyUntil = new Map(); // origin -> unix ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfterMs(ra) {
  if (!ra) return null;
  const num = Number(ra);
  if (!Number.isNaN(num)) return Math.max(0, num * 1000);
  const dateMs = Date.parse(ra);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function originFromConfig(config) {
  try {
    let url = config.url || '';
    if (config.baseURL && !/^https?:\/\//i.test(url)) {
      url = new URL(url, config.baseURL).toString();
    }
    return new URL(url).origin;
  } catch {
    return 'global';
  }
}

async function waitForPenalty(key, jitterMs) {
  const now = Date.now();
  const until = penaltyUntil.get(key) || 0;
  if (until > now) {
    const wait = until - now + Math.floor(Math.random() * jitterMs);
    await sleep(wait);
  }
}

function setPenalty(key, delayMs) {
  const now = Date.now();
  const newUntil = now + delayMs;
  const prev = penaltyUntil.get(key) || 0;
  // extend, don't shorten
  penaltyUntil.set(key, Math.max(prev, newUntil));
}

function attachRetryOn429(instance, {
  maxRetries = 5,
  fallbackDelayMs = 10_000,
  maxDelayMs = 120_000,
  jitterMs = 500,
  log = (..._args) => {} // e.g., (msg) => console.log('[rate-limit]', msg)
} = {}) {
  instance.interceptors.request.use(async (config) => {
    const key = originFromConfig(config);
    await waitForPenalty(key, jitterMs);
    return config;
  });

  instance.interceptors.response.use(
    (res) => res,
    async (err) => {
      const res = err.response;
      const cfg = err.config;
      if (!cfg || !res || res.status !== 429) throw err;

      cfg._retryCount = (cfg._retryCount || 0) + 1;
      if (cfg._retryCount > maxRetries) {
        log(`429 retry exhausted after ${maxRetries} attempts for ${cfg.url}`);
        throw err;
      }

      const key = originFromConfig(cfg);
      let delay = parseRetryAfterMs(res.headers?.['retry-after']);
      if (delay == null) {
        // escalate on repeated 429s, but still start at 10s fallback
        delay = Math.min(maxDelayMs, fallbackDelayMs * 2 ** (cfg._retryCount - 1));
      }
      delay += Math.floor(Math.random() * jitterMs);

      setPenalty(key, delay);
      log(`429 -> backing off ${Math.round(delay)}ms (attempt ${cfg._retryCount}) for ${key} ${cfg.url}`);
      await sleep(delay);

      return instance.request(cfg);
    }
  );
}

attachRetryOn429(axios, {
  fallbackDelayMs: 10_000,
  maxRetries: 5,
  jitterMs: 400,
  maxDelayMs: 60_000,
  log: (...args) => console.log('[429]', ...args)
});
// --- end 429-aware interceptors ---

const cheerio = require('cheerio');
const cors = require('cors');
const stringSimilarity = require('string-similarity');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

app.use(cors());

// Middleware to check for AUTHORIZATION header
app.use((req, res, next) => {
  const apiKey = req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

class LubimyCzytacProvider {
  constructor() {
    this.id = 'lubimyczytac';
    this.name = 'Lubimy Czytać';
    this.baseUrl = 'https://lubimyczytac.pl';
    this.textDecoder = new TextDecoder('utf-8');
  }

  decodeText(text) {
    return this.textDecoder.decode(new TextEncoder().encode(text));
  }

  async searchBooks(query, author = '') {
    const cacheKey = `${query}-${author}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    try {
      const currentTime = new Date().toLocaleString("pl-PL", {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });

      console.log(`Current time: ${currentTime}`);
      console.log(`Input details: "${query}" by "${author}"`);

      if (!author && query.includes("-")) {
        author = query.split("-")[0].replace(/\./g, " ").trim();
      } else {
        author = author.split("-")[0].replace(/\./g, " ").trim();
      }

      console.log("Extracted author: ", author);

      let cleanedTitle = query;
      if (!/^".*"$/.test(cleanedTitle)) {
        cleanedTitle = cleanedTitle.replace(/(\d+kbps)/g, '')
          .replace(/\bVBR\b.*$/gi, '')
          .replace(/^[\w\s.-]+-\s*/g, '')
          .replace(/czyt.*/gi, '')
          .replace(/.*-/, '')
          .replace(/.*?(T[\s.]?\d{1,3}).*?(.*)$/i, '$2')
          .replace(/.*?(Tom[\s.]?\d{1,3}).*?(.*)$/i, '$2')
          .replace(/.*?\(\d{1,3}\)\s*/g, '')
          .replace(/\(.*?\)/g, '')
          .replace(/\[.*?\]/g, '')
          .replace(/\(/g, ' ')
          .replace(/[^\p{L}\d]/gu, ' ')
          .replace(/\./g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/superprodukcja/i, '')
          .trim();
      } else {
        cleanedTitle = cleanedTitle.replace(/^"(.*)"$/, '$1');
      }

      console.log("Extracted title: ", cleanedTitle);

      let booksSearchUrl = `${this.baseUrl}/szukaj/ksiazki?phrase=${encodeURIComponent(cleanedTitle)}`;
      let audiobooksSearchUrl = `${this.baseUrl}/szukaj/audiobooki?phrase=${encodeURIComponent(cleanedTitle)}`;
      if (author) {
        booksSearchUrl += `&author=${encodeURIComponent(author)}`;
        audiobooksSearchUrl += `&author=${encodeURIComponent(author)}`;
      }

      console.log('Books Search URL:', booksSearchUrl);
      console.log('Audiobooks Search URL:', audiobooksSearchUrl);

      const booksResponse = await axios.get(booksSearchUrl, { responseType: 'arraybuffer' });
      const audiobooksResponse = await axios.get(audiobooksSearchUrl, { responseType: 'arraybuffer' });

      const booksMatches = this.parseSearchResults(booksResponse.data, 'book');
      const audiobooksMatches = this.parseSearchResults(audiobooksResponse.data, 'audiobook');

      let allMatches = [...booksMatches, ...audiobooksMatches];

      // Calculate similarity scores and sort the matches
      allMatches = allMatches.map(match => {
        const titleSimilarity = stringSimilarity.compareTwoStrings(match.title.toLowerCase(), cleanedTitle.toLowerCase());

        let combinedSimilarity;
        if (author) {
          const authorSimilarity = Math.max(...match.authors.map(a =>
            stringSimilarity.compareTwoStrings(a.toLowerCase(), author.toLowerCase())
          ));
          // Combine title and author similarity scores if author is provided
          combinedSimilarity = (titleSimilarity * 0.6) + (authorSimilarity * 0.4);
        } else {
          // Use only title similarity if no author is provided
          combinedSimilarity = titleSimilarity;
        }

        return { ...match, similarity: combinedSimilarity };
      }).sort((a, b) => {
        // Primary sort: by similarity (descending)
        if (b.similarity !== a.similarity) {
          return b.similarity - a.similarity;
        }

        // Secondary sort: prioritize audiobooks if similarity is equal
        const typeValueA = a.type === 'audiobook' ? 1 : 0;
        const typeValueB = b.type === 'audiobook' ? 1 : 0;
        return typeValueB - typeValueA;
      }).slice(0, 20); // Max 20 matches

      const fullMetadata = await Promise.all(allMatches.map(match => this.getFullMetadata(match)));

      const result = { matches: fullMetadata };
      cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Error searching books:', error.message, error.stack);
      return { matches: [] };
    }
  }

// ADDED THIS FUNCTION BACK:
  parseSearchResults(responseData, type) {
    const decodedData = this.decodeText(responseData);
    const $ = cheerio.load(decodedData);
    const matches = [];

    $('.authorAllBooks__single').each((index, element) => {
      const $book = $(element);
      const $bookInfo = $book.find('.authorAllBooks__singleText');

      const title = $bookInfo.find('.authorAllBooks__singleTextTitle').text().trim();
      const bookUrl = $bookInfo.find('.authorAllBooks__singleTextTitle').attr('href');
      const authors = $bookInfo.find('a[href*="/autor/"]').map((i, el) => $(el).text().trim()).get();

      if (title && bookUrl) {
        matches.push({
          id: bookUrl.split('/').pop(),
          title: this.decodeUnicode(title),
          authors: authors.map(author => this.decodeUnicode(author)),
          url: `${this.baseUrl}${bookUrl}`,
          type: type,
          source: {
            id: this.id,
            description: this.name,
            link: this.baseUrl,
          },
        });
      }
    });

    return matches;
  }

  async getFullMetadata(match) {
    try {
      const response = await axios.get(match.url, { responseType: 'arraybuffer' });
      const decodedData = this.decodeText(response.data);
      const $ = cheerio.load(decodedData);

      const cover = $('meta[property="og:image"]').attr('content') || '';
      const publisher = $('dt:contains("Wydawnictwo:")').next('dd').find('a').text().trim() || '';
      const languages = $('dt:contains("Język:")').next('dd').text().trim().split(', ') || [];
      const description = $('.collapse-content').html() || $('meta[property="og:description"]').attr('content') || '';
      const seriesElement = $('span.d-none.d-sm-block.mt-1:contains("Cykl:")').find('a').text().trim();
      const series = this.extractSeriesName(seriesElement);
      const seriesIndex = this.extractSeriesIndex(seriesElement);
      const genres = this.extractGenres($);
      const tags = this.extractTags($);
      const rating = parseFloat($('meta[property="books:rating:value"]').attr('content')) / 2 || null;
      const isbn = $('meta[property="books:isbn"]').attr('content') || '';

      let publishedDate, pages;
      try {
        publishedDate = this.extractPublishedDate($);
        pages = this.extractPages($);
      } catch (error) {
        console.error('Error extracting published date or pages:', error.message);
      }

      const translator = this.extractTranslator($);

      const fullMetadata = {
        ...match,
        cover,
        description: this.enrichDescription(description, pages, publishedDate, translator),
        languages: languages.map(lang => this.getLanguageName(lang)),
        publisher,
        publishedDate,
        rating,
        series,
        seriesIndex,
        genres,
        tags,
        identifiers: {
          isbn,
          lubimyczytac: match.id,
        },
      };

      return fullMetadata;
    } catch (error) {
      console.error(`Error fetching full metadata for ${match.title}:`, error.message, error.stack);
      return match;
    }
  }

  extractSeriesName(seriesElement) {
    if (!seriesElement) return null;
    return seriesElement.replace(/\s*\(tom \d+.*?\)\s*$/, '').trim();
  }

  extractSeriesIndex(seriesElement) {
    if (!seriesElement) return null;
    const match = seriesElement.match(/\(tom (\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  extractPublishedDate($) {
    const dateText = $('dt[title*="Data pierwszego wydania"]').next('dd').text().trim();
    return dateText ? new Date(dateText) : null;
  }

  extractPages($) {
    try {
      const pagesText = $('script[type="application/ld+json"]').text();
      if (pagesText) {
        const data = JSON.parse(pagesText);
        return data.numberOfPages || null;
      }
    } catch (error) {
      console.error('Error parsing JSON for pages:', error.message);
    }
    return null;
  }

  extractTranslator($) {
    return $('dt:contains("Tłumacz:")').next('dd').find('a').text().trim() || null;
  }

  extractGenres($) {
    const genreText = $('.book__category.d-sm-block.d-none').text().trim();
    return genreText ? genreText.split(',').map(genre => genre.trim()) : [];
  }

  extractTags($) {
    return $('a[href*="/ksiazki/t/"]').map((i, el) => $(el).text().trim()).get() || [];
  }

  stripHtmlTags(html) {
    return html.replace(/<[^>]*>/g, '');
  }

  enrichDescription(description, pages, publishedDate, translator) {
    let enrichedDescription = this.stripHtmlTags(description);

    if (enrichedDescription === "Ta książka nie posiada jeszcze opisu.") {
      enrichedDescription = "Brak opisu.";
    } else {
      if (pages) {
        enrichedDescription += `\n\nKsiążka ma ${pages} stron.`;
      }

      if (publishedDate) {
        enrichedDescription += `\n\nData pierwszego wydania: ${publishedDate.toLocaleDateString()}`;
      }

      if (translator) {
        enrichedDescription += `\n\nTłumacz: ${translator}`;
      }
    }

    return enrichedDescription;
  }

  getLanguageName(language) {
    const languageMap = {
      polski: 'pol',
      angielski: 'eng',
    };
    return languageMap[language.toLowerCase()] || language;
  }

  decodeUnicode(str) {
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
}

const provider = new LubimyCzytacProvider();

app.get('/search', async (req, res) => {
  try {
    console.log(`------------------------------------------------------------------------------------------------`);
    console.log('Received search request:', req.query);
    const query = req.query.query;
    const author = req.query.author;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const results = await provider.searchBooks(query, author);

    const formattedResults = {
      matches: results.matches.map(book => {
        const year = book.publishedDate ? new Date(book.publishedDate).getFullYear() : null;
        const publishedYear = year ? year.toString() : undefined;
        const authorsArr = book.authors && book.authors.length ? book.authors.map(a => a.replace(/\s+/g, ' ').trim()).filter(Boolean) : undefined;

        return {
          title: book.title,
          subtitle: book.subtitle || undefined,
          author: authorsArr ? authorsArr.join(', ') : undefined,
          authors: authorsArr,
          narrator: book.narrator || undefined,
          publisher: book.publisher || undefined,
          publishedYear: publishedYear,
          description: book.description || undefined,
          cover: book.cover || undefined,
          isbn: book.identifiers?.isbn || undefined,
          asin: book.identifiers?.asin || undefined,
          genres: book.genres || undefined,
          tags: book.tags || undefined,
          series: book.series ? [{
            series: book.series,
            sequence: book.seriesIndex ? book.seriesIndex.toString() : undefined
          }] : undefined,
          language: book.languages && book.languages.length > 0 ? book.languages[0] : undefined,
          duration: book.duration || undefined,
          type: book.type,
          similarity: book.similarity
        };
      })
    };

    console.log('Sending response:', JSON.stringify(formattedResults, null, 2));
    res.json(formattedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`LubimyCzytac provider listening on port ${port}`);
});

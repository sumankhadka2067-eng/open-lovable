import { NextRequest, NextResponse } from 'next/server';

/**
 * This route originally used Firecrawl to search the web.
 * Since Firecrawl is disabled, we will return an empty result set 
 * or a placeholder message to prevent frontend errors.
 */
export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    
    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    // Since Firecrawl is removed, we return an empty array.
    // This ensures the UI doesn't break but tells the user search is unavailable.
    const results: any[] = [];

    // Optional: If you want to integrate a free Search API in the future (like DuckDuckGo or Tavily),
    // you would place that fetch logic here.

    return NextResponse.json({ 
      results,
      message: "Web search is currently disabled (Firecrawl removed)." 
    });

  } catch (error) {
    console.error('Search route error:', error);
    return NextResponse.json(
      { error: 'Failed to perform search operations' },
      { status: 500 }
    );
  }
}

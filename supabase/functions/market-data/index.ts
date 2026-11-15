import { withSupabase } from 'npm:@supabase/server@1.9.2';
import { marketData } from './market-data.ts';

export default {
    fetch: withSupabase({ auth: 'user' }, request =>
        marketData(request, Deno.env.get('TWELVE_DATA_API_KEY'))
    )
};

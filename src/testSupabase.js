import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function testInsert() {
  try {
    const { data, error } = await supabase
      .from('bot_messages') // table name
      .insert([
        {
          channel: 'test-channel',
          direction: 'inbound',
          user_ref: 'test-user',
          content: 'Hello from test script!',
          metadata: {}, // empty JSON object
        },
      ]);

    if (error) {
      console.error('❌ Supabase insert error:', error);
    } else {
      console.log('✅ Insert successful:', data);
    }
  } catch (err) {
    console.error('❌ Unexpected error:', err);
  }
}

testInsert();

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function testConnection() {
  const { data, error } = await supabase
    .from('your_table_name')
    .select('*')
    .limit(1);

  if (error) console.error('❌ Supabase error:', error);
  else console.log('✅ Supabase data:', data);
}

testConnection();


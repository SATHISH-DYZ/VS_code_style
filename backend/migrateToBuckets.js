import { supabase } from './src/config/supabaseClient.js';
import dotenv from 'dotenv';
dotenv.config();

const DEFAULT_USER_ID = 'user_system';

async function migrate() {
    console.log('🚀 Starting Migration: Database -> Supabase Storage Bucket...');

    // 1. Fetch all files and folders from database
    const { data: items, error: fetchError } = await supabase
        .from('workspace_files')
        .select('*')
        .eq('user_id', DEFAULT_USER_ID);

    if (fetchError) {
        console.error('❌ Error fetching items:', fetchError.message);
        return;
    }

    console.log(`Found ${items.length} items to migrate.`);

    for (const item of items) {
        try {
            if (item.is_dir) {
                console.log(`Creating folder placeholder: ${item.path}...`);
                const { error: uploadError } = await supabase.storage
                    .from('workspace')
                    .upload(`${DEFAULT_USER_ID}/${item.path}/.placeholder`, '', {
                        upsert: true,
                        contentType: 'text/plain'
                    });

                if (uploadError) {
                    console.error(`  ❌ Failed folder ${item.path}:`, uploadError.message, uploadError);
                } else {
                    console.log(`  ✅ Synced folder ${item.path}`);
                }
                continue;
            }

            if (item.content === null && item.content !== '') continue;

            console.log(`Uploading file: ${item.path}...`);
            const { error: uploadError } = await supabase.storage
                .from('workspace')
                .upload(`${DEFAULT_USER_ID}/${item.path}`, item.content, {
                    upsert: true,
                    contentType: 'text/plain'
                });

            if (uploadError) {
                console.error(`  ❌ Failed file ${item.path}:`, uploadError.message, uploadError);
            } else {
                console.log(`  ✅ Synced file ${item.path}`);
            }
        } catch (e) {
            console.error(`  ❌ Exception for ${item.path}:`, e.message);
        }
    }

    console.log('\n✨ Migration Complete!');
}

migrate();

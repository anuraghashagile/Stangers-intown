
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, sendPersistentGlobalMessage, fetchRecentGlobalMessages } from '../lib/supabase';
import { Message, UserProfile } from '../types';

export const useGlobalChat = (userProfile: UserProfile | null, myPeerId: string | null) => {
  const [globalMessages, setGlobalMessages] = useState<Message[]>([]);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persistent history on mount with retry
  useEffect(() => {
    let mounted = true;
    
    const loadHistory = async (attempt = 1) => {
      try {
        const history = await fetchRecentGlobalMessages();
        if (mounted && history.length > 0) {
          setGlobalMessages(prev => {
             // Correctly map history items with current 'me' status
             const processedHistory = history.map(msg => ({
               ...msg,
               sender: (msg.senderPeerId === myPeerId ? 'me' : 'stranger') as 'me' | 'stranger'
             }));

             // Create a Set of IDs from the history we just fetched
             const historyIds = new Set(processedHistory.map(m => m.id));

             // Find any messages in 'prev' (e.g. from realtime subscription) that are NOT in the fetched history
             // This happens if a new message arrives while we are fetching history
             const existingNewer = prev.filter(m => !historyIds.has(m.id));

             // Update sender status for these existing messages too, just in case myPeerId changed
             const processedExisting = existingNewer.map(msg => ({
                ...msg,
                sender: (msg.senderPeerId === myPeerId ? 'me' : 'stranger') as 'me' | 'stranger'
             }));

             // Merge: History (oldest first) + ExistingNewer (which should be newer)
             // fetchRecentGlobalMessages returns messages reverse-ordered (oldest at index 0)
             return [...processedHistory, ...processedExisting].sort((a, b) => a.timestamp - b.timestamp);
          });
        }
      } catch (err) {
        if (attempt < 3 && mounted) {
           retryTimeoutRef.current = setTimeout(() => loadHistory(attempt + 1), 2000);
        }
      }
    };
    
    loadHistory();

    return () => {
      mounted = false;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [myPeerId]); // Re-run when myPeerId changes to correctly identify 'me' vs 'stranger'

  // Subscribe to new DB inserts (Realtime)
  useEffect(() => {
    // Unique channel name to prevent collisions
    const channelName = `global-chat-sync-v2-${Date.now()}`;
    const channel = supabase.channel(channelName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'global_messages' },
        (payload) => {
          const row = payload.new;
          const newMessage: Message = {
            id: row.message_id,
            text: row.content,
            sender: row.sender_id === myPeerId ? 'me' : 'stranger',
            senderName: row.sender_name,
            senderPeerId: row.sender_id,
            senderProfile: row.sender_profile,
            timestamp: new Date(row.created_at).getTime(),
            type: 'text'
          };
          
          setGlobalMessages(prev => {
            // Dedup
            if (prev.some(m => m.id === newMessage.id)) return prev;
            return [...prev, newMessage];
          });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // console.log('Connected to Global Chat DB Stream');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('Global Chat DB Stream Error');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [myPeerId]);

  const sendGlobalMessage = useCallback(async (text: string) => {
    if (!userProfile) return;

    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(),
      text,
      sender: 'me',
      senderName: userProfile.username, 
      senderPeerId: myPeerId || undefined, 
      senderProfile: userProfile,
      timestamp: Date.now(),
      type: 'text'
    };

    // Optimistic UI update
    setGlobalMessages(prev => [...prev, newMessage]);

    // Send to DB
    try {
       await sendPersistentGlobalMessage(newMessage);
    } catch (err) {
       console.error("Failed to send global message to DB. Retrying locally...", err);
       // Alert user if strictly needed, otherwise we rely on optimistic update locally
    }
  }, [userProfile, myPeerId]);

  return {
    globalMessages,
    sendGlobalMessage
  };
};

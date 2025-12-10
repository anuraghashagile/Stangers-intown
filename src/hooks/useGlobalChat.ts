
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
        if (mounted) {
          // Mark my own messages based on persistent peer ID
          const processed = history.map(msg => ({
            ...msg,
            sender: (msg.senderPeerId === myPeerId ? 'me' : 'stranger') as 'me' | 'stranger'
          }));
          
          setGlobalMessages(processed);
        }
      } catch (err) {
        console.error(`Failed to load global chat history (Attempt ${attempt})`, err);
        if (attempt < 3 && mounted) {
           retryTimeoutRef.current = setTimeout(() => loadHistory(attempt + 1), 2000);
        }
      }
    };
    
    if (myPeerId) {
      loadHistory();
    }

    return () => {
      mounted = false;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [myPeerId]);

  // Subscribe to new DB inserts (Realtime)
  useEffect(() => {
    const channel = supabase.channel('global-chat-db-sync')
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
          console.log('Connected to Global Chat DB Stream');
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
       console.error("Failed to send global message to DB", err);
       // Optional: Revert optimistic update here if needed
    }
  }, [userProfile, myPeerId]);

  return {
    globalMessages,
    sendGlobalMessage
  };
};

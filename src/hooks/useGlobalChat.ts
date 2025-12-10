
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, sendPersistentGlobalMessage, fetchRecentGlobalMessages } from '../lib/supabase';
import { Message, UserProfile } from '../types';

export const useGlobalChat = (userProfile: UserProfile | null, myPeerId: string | null) => {
  const [globalMessages, setGlobalMessages] = useState<Message[]>([]);

  // Load persistent history on mount
  useEffect(() => {
    const loadHistory = async () => {
      const history = await fetchRecentGlobalMessages();
      // Mark my own messages
      const processed = history.map(msg => ({
        ...msg,
        sender: (msg.senderPeerId === myPeerId ? 'me' : 'stranger') as 'me' | 'stranger'
      }));
      setGlobalMessages(processed);
    };
    loadHistory();
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
      .subscribe();

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
    await sendPersistentGlobalMessage(newMessage);
  }, [userProfile, myPeerId]);

  return {
    globalMessages,
    sendGlobalMessage
  };
};


import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, sendPersistentGlobalMessage, fetchRecentGlobalMessages } from '../lib/supabase';
import { Message, UserProfile } from '../types';

export const useGlobalChat = (userProfile: UserProfile | null, myPeerId: string | null) => {
  const [globalMessages, setGlobalMessages] = useState<Message[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Load persistent history on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await fetchRecentGlobalMessages();
        if (history && history.length > 0) {
          setGlobalMessages(prev => {
             // Map history to current 'me' status based on CURRENT myPeerId
             const processedHistory = history.map(msg => ({
               ...msg,
               sender: (msg.senderPeerId === myPeerId ? 'me' : 'stranger') as 'me' | 'stranger'
             }));

             // Merge with existing state, prioritizing history (DB is truth)
             // We use a Map to dedup by ID
             const msgMap = new Map();
             processedHistory.forEach(m => msgMap.set(m.id, m));
             prev.forEach(m => {
                if (!msgMap.has(m.id)) msgMap.set(m.id, m);
             });
             
             return Array.from(msgMap.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);
          });
        }
      } catch (err) {
        console.error("Failed to load global chat history", err);
      }
    };
    
    loadHistory();
  }, [myPeerId]); 

  // Subscribe to new DB inserts (Realtime)
  useEffect(() => {
    // Use a static channel name for global chat to ensure everyone is in the same "room"
    const channelName = 'global-chat-room-v1';

    // Cleanup previous channel if exists
    if (channelRef.current) {
       supabase.removeChannel(channelRef.current);
    }

    const channel = supabase.channel(channelName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'global_messages' },
        (payload) => {
          const row = payload.new;
          // console.log("Received global message:", row);
          
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
            if (prev.some(m => m.id === newMessage.id)) return prev;
            return [...prev, newMessage].sort((a, b) => a.timestamp - b.timestamp);
          });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // console.log('Connected to Global Chat Stream');
        }
      });
      
    channelRef.current = channel;

    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, [myPeerId]);

  const sendGlobalMessage = useCallback(async (text: string) => {
    if (!userProfile) return;

    // Prevent sending if we don't have an ID yet (DB will reject)
    if (!myPeerId) {
       console.warn("Cannot send global message: No Peer ID yet");
       return;
    }

    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(),
      text,
      sender: 'me',
      senderName: userProfile.username, 
      senderPeerId: myPeerId, 
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
       console.error("Failed to send global message to DB:", err);
       // We keep the optimistic message, but maybe show an error state in a real app
    }
  }, [userProfile, myPeerId]);

  return {
    globalMessages,
    sendGlobalMessage
  };
};

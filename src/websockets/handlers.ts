import { Server, Socket } from 'socket.io';
import { pool } from '../db';
import { getUserFromToken } from '../controllers/usersRoutes';
import cookie from 'cookie';

export const websocketHandlers = (io: Server): void => {

  // Defines connected users map
  const connectedUsers = new Map<string, string>(); // userId -> socket.id

  const verifyUser = async (socket: Socket, userId: string): Promise<boolean> => {
    const cookies = cookie.parse(socket.request.headers.cookie || '');
    const token = cookies.auth_token;
  
    if (!token) {
      socket.emit('error', { message: 'Unauthorized. Token not found' });
      socket.disconnect(); // Disconnects user
      return false;
    }
  
    const user = getUserFromToken(token);
    if (!user || user.userid !== userId) {
      socket.emit('error', { message: 'Unauthorized. Invalid or expired token' });
      socket.disconnect(); // Disconnects user
      return false;
    }
  
    return true;
  };

  io.on('connection', (socket: Socket) => {
    console.log(`Cliente conectado: ${socket.id}`);

    const cookies = cookie.parse(socket.request.headers.cookie || '');
    const token = cookies.auth_token;

    if (!token) {
      socket.emit('error', { message: 'Unauthorized. Token not found' });
      socket.disconnect();
      return;
    }

    const userId = getUserFromToken(token)?.userid;

    if (!userId) {
      socket.emit('error', { message: 'Unauthorized. Invalid token' });
      socket.disconnect();
      return;
    }
    
    // Add user to connected users map
    connectedUsers.set(userId, socket.id);

    // Gets allthe conversationss that includes the user
    const conversationsQuery = `
    SELECT chatid
    FROM chats
    WHERE buyeruserid = $1 OR owneruserid = $1;
    `;

    pool.query(conversationsQuery, [userId], (err, result) => {
      if (err) {
        console.error('Error fetching conversations:', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
        return;
      }

      // Connects the user to all chats rooms
      result.rows.forEach((row) => {
        socket.join(`chat_${row.chatid}`);
        console.log(`Usuario ${userId} unido a la conversación ${row.chatid}`);
      });
    });

    socket.on('joinConversation', async ({ chatId }) => {

      if (!(await verifyUser(socket, userId))) {
        return; // If token is not valid, event stops here
      }

      try {
        // Gets details from conversation, including profile images from participants
        const chatDetailsQuery = `
          SELECT
            c.chatid,
            c.buyeruserid,
            c.owneruserid,
            u_buyer.profileimageurl AS buyer_image,
            u_owner.profileimageurl AS owner_image
          FROM chats c
          JOIN users u_buyer ON c.buyeruserid = u_buyer.userid
          JOIN users u_owner ON c.owneruserid = u_owner.userid
          WHERE c.chatid = $1;
        `;
    
        const chatDetailsResult = await pool.query(chatDetailsQuery, [chatId]);
    
        if (chatDetailsResult.rows.length === 0) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }
    
        const { buyeruserid, owneruserid, buyer_image, owner_image } = chatDetailsResult.rows[0];
    
        // Defines profile image from current user and the other one
        const isCurrentUserImage = userId === buyeruserid ? buyer_image : owner_image;
        const otherUserImage = userId === buyeruserid ? owner_image : buyer_image;
    
        // Charge all the message od the conversation
        const messagesResult = await pool.query(
          `
          SELECT
            m.messageid,
            m.content,
            m.senderuserid,
            m.createdat
          FROM messages m
          WHERE m.chatid = $1
          ORDER BY m.createdat ASC;
          `,
          [chatId]
        );
    
        // Verifies if there are no messages
        if (messagesResult.rows.length === 0) {
          socket.emit('error', { message: 'No messages found for this chat' });
          return;
        }
    
        // Formats the messsages for the user
        const formattedMessages = messagesResult.rows.map((message) => ({
          messageId: message.messageid,
          isCurrentUser: message.senderuserid === userId, //Verifies if the message is from the current user
          content: message.content,
          createdAt: message.createdat, // Gives back the date at his current format
          senderImage: message.senderuserid === userId ? isCurrentUserImage : otherUserImage, // Assigns the right profile image
        }));
    
        // Sends messages for the user including the users images
        socket.emit('messages_listed', {
          chatId,
          messages: formattedMessages,
          isCurrentUserImage, // Profile image of the current user
          otherUserImage, // Profile image of the other user
        });
      } catch (err: any) {
        console.error('Error fetching conversation details:', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });

    // Event to create a conversation and to send a message
    socket.on('createConversationAndMessage', async ({ productid, content }) => {
      if (!(await verifyUser(socket, userId))) {
        return; // If token is not valid, event stops here
      }
    
      try {
        if (!productid || !content) {
          socket.emit('error', { message: 'All data is mandatory' });
          return;
        }
    
        // Gets product's owner
        const productQuery = await pool.query('SELECT userid FROM products WHERE productid = $1', [productid]);
        if (productQuery.rows.length === 0) {
          socket.emit('error', { message: 'Product not found' });
          return;
        }
    
        const owneruserid = productQuery.rows[0].userid;
    
        // Verifies if conversation already exists
        const chatQuery = await pool.query(
          'SELECT chatid, buyeruserid, owneruserid FROM chats WHERE productid = $1 AND (buyeruserid = $2 OR owneruserid = $2)',
          [productid, userId]
        );
    
        let chatId;
        let buyeruserid;
    
        if (chatQuery.rows.length === 0) {
          // Avoids users creatig conversations for their own products
          if (userId === owneruserid) {
            socket.emit('error', { message: 'You cannot create a conversation for your own product' });
            return;
          }
    
          // Creates a new conversation
          const newChat = await pool.query(
            'INSERT INTO chats (productid, buyeruserid, owneruserid, createdat) VALUES ($1, $2, $3, NOW()) RETURNING chatid',
            [productid, userId, owneruserid]
          );
          chatId = newChat.rows[0].chatid;
          buyeruserid = userId;
        } else {
          chatId = chatQuery.rows[0].chatid;
          buyeruserid = chatQuery.rows[0].buyeruserid;
        }
    
        // Creates the message related to the current conversation
        const newMessage = await pool.query(
          'INSERT INTO messages (chatid, senderuserid, content, createdat) VALUES ($1, $2, $3, NOW()) RETURNING *',
          [chatId, userId, content]
        );
    
        // Formats respose with `isCurrentUser`
        const formattedMessage = {
          chatId,
          senderUserId: newMessage.rows[0].senderuserid,
          content: newMessage.rows[0].content,
          createdAt: newMessage.rows[0].createdat,
        };
    
        // Emits the message to all users connected at the room except by the current user
        socket.broadcast.to(`chat_${chatId}`).emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: false },
        });
    
        // Emits event to sender with the created message
        socket.emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: true },
        });
    
        // Identifies the receiver
        const recipientUserId = userId === owneruserid ? buyeruserid : owneruserid;
    
        // Gets the socketid from the receiver
        const recipientSocketId = connectedUsers.get(recipientUserId);
    
        // Gets the socket id from the sender
        const senderSocketId = connectedUsers.get(userId);
    
        // Gets the updated list of conversations for the sender and for receiver
        const conversationsQuery = `
          SELECT
            c.chatid,
            c.productid,
            c.buyeruserid,
            c.owneruserid,
            p.name AS product_name,
            p.imageurls[1] AS product_image,
            u_buyer.profileimageurl AS buyer_image,
            u_owner.profileimageurl AS owner_image,
            COALESCE(
              (SELECT m.content
              FROM messages m
              WHERE m.chatid = c.chatid
              ORDER BY m.createdat DESC
              LIMIT 1),
              'No messages yet'
            ) AS last_message,
            COALESCE(
              (SELECT m.createdat
              FROM messages m
              WHERE m.chatid = c.chatid
              ORDER BY m.createdat DESC
              LIMIT 1),
              c.createdat
            ) AS last_message_date
          FROM chats c
          JOIN products p ON c.productid = p.productid
          JOIN users u_buyer ON c.buyeruserid = u_buyer.userid
          JOIN users u_owner ON c.owneruserid = u_owner.userid
          WHERE c.buyeruserid = $1 OR c.owneruserid = $1
          ORDER BY last_message_date DESC;
        `;
    
        // Gets conversations for receiver
        const recipientConversationsResult = await pool.query(conversationsQuery, [recipientUserId]);
        const formattedRecipientConversations = recipientConversationsResult.rows.map((conv) => ({
          chatId: conv.chatid,
          productId: conv.productid,
          productName: conv.product_name,
          productImage: conv.product_image,
          buyerImage: conv.buyer_image,
          ownerImage: conv.owner_image,
          lastMessage: conv.last_message,
          lastMessageDate: conv.last_message_date,
          otherUserId: conv.owneruserid === recipientUserId ? conv.buyeruserid : conv.owneruserid,
          otherUserImage: conv.owneruserid === recipientUserId ? conv.buyer_image : conv.owner_image,
        }));
    
        // Gets conversations for sender
        const senderConversationsResult = await pool.query(conversationsQuery, [userId]);
        const formattedSenderConversations = senderConversationsResult.rows.map((conv) => ({
          chatId: conv.chatid,
          productId: conv.productid,
          productName: conv.product_name,
          productImage: conv.product_image,
          buyerImage: conv.buyer_image,
          ownerImage: conv.owner_image,
          lastMessage: conv.last_message,
          lastMessageDate: conv.last_message_date,
          otherUserId: conv.owneruserid === userId ? conv.buyeruserid : conv.owneruserid,
          otherUserImage: conv.owneruserid === userId ? conv.buyer_image : conv.owner_image,
        }));
    
        // Emits updated conversation list for receiver
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('conversations_listed', {
            message: 'Conversations retrieved successfully',
            conversations: formattedRecipientConversations,
          });
        }
    
        // Emits updated conversation list for sender
        if (senderSocketId) {
          io.to(senderSocketId).emit('conversations_listed', {
            message: 'Conversations retrieved successfully',
            conversations: formattedSenderConversations,
          });
        }
    
        // Confirmation for event activation
        socket.emit('event_confirmation', {
          message: 'Event createConversationAndMessage triggered successfully',
        });
        socket.emit('listConversations');
      } catch (err: any) {
        console.error('Error while creating message: ', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });

    // Event for sending message to an existing conversation
    socket.on('sendMessage', async ({ chatId, content }) => {

      try {
        if (!chatId || !content) {
          socket.emit('error', { message: 'All data is mandatory' });
          return;
        }

        // Verifies if conversation exists and if user is involved
        const chatQuery = await pool.query(
          'SELECT buyeruserid, owneruserid FROM chats WHERE chatid = $1 AND (buyeruserid = $2 OR owneruserid = $2)',
          [chatId, userId]
        );

        if (chatQuery.rows.length === 0) {
          socket.emit('error', { message: 'Conversation not found or unauthorized' });
          return;
        }

        const { buyeruserid, owneruserid } = chatQuery.rows[0];

        // Creates the message related to the conversation
        const newMessage = await pool.query(
          'INSERT INTO messages (chatid, senderuserid, content, createdat) VALUES ($1, $2, $3, NOW()) RETURNING *',
          [chatId, userId, content]
        );

        // Formats the response with `isCurrentUser`
        const formattedMessage = {
          chatId,
          senderUserId: newMessage.rows[0].senderuserid,
          content: newMessage.rows[0].content,
          createdAt: newMessage.rows[0].createdat,
        };

        // Emits the new message in the room except form sender
        socket.broadcast.to(`chat_${chatId}`).emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: false },
        });

        // Emits the new message to the sender
        socket.emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: true },
        });

        // Identifies receiver
        const recipientUserId = userId === owneruserid ? buyeruserid : owneruserid;

        // Gets the socketid from receiver
        const recipientSocketId = connectedUsers.get(recipientUserId);

        // Gets updated conversations list for receiver
        const conversationsQuery = `
          SELECT
            c.chatid,
            c.productid,
            c.buyeruserid,
            c.owneruserid,
            p.name AS product_name,
            p.imageurls[1] AS product_image,
            u_buyer.profileimageurl AS buyer_image,
            u_owner.profileimageurl AS owner_image,
            COALESCE(
              (SELECT m.content
              FROM messages m
              WHERE m.chatid = c.chatid
              ORDER BY m.createdat DESC
              LIMIT 1),
              'No messages yet'
            ) AS last_message,
            COALESCE(
              (SELECT m.createdat
              FROM messages m
              WHERE m.chatid = c.chatid
              ORDER BY m.createdat DESC
              LIMIT 1),
              c.createdat
            ) AS last_message_date
          FROM chats c
          JOIN products p ON c.productid = p.productid
          JOIN users u_buyer ON c.buyeruserid = u_buyer.userid
          JOIN users u_owner ON c.owneruserid = u_owner.userid
          WHERE c.buyeruserid = $1 OR c.owneruserid = $1
          ORDER BY last_message_date DESC;
        `;

        const conversationsResult = await pool.query(conversationsQuery, [recipientUserId]);

        const formattedConversations = conversationsResult.rows.map((conv) => ({
          chatId: conv.chatid,
          productId: conv.productid,
          productName: conv.product_name,
          productImage: conv.product_image,
          buyerImage: conv.buyer_image,
          ownerImage: conv.owner_image,
          lastMessage: conv.last_message,
          lastMessageDate: conv.last_message_date,
          otherUserId: conv.owneruserid === recipientUserId ? conv.buyeruserid : conv.owneruserid,
          otherUserImage: conv.owneruserid === recipientUserId ? conv.buyer_image : conv.owner_image,
        }));

        // Emits the updated conversations list to receiver
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('conversations_listed', {
            message: 'Conversations retrieved successfully',
            conversations: formattedConversations,
          });
        }

        //  Confirms the activation of the event 
        socket.emit('event_confirmation', {
          message: 'Event sendMessage triggered successfully',
        });
        socket.emit('listConversations');
      } catch (err: any) {
        console.error('Error while creating message: ', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });
    
    // List the messages of a conversation
    socket.on('listMessages', async ({ chatId, date }) => {

      if (!(await verifyUser(socket, userId))) {
        return; // If the token is invalid, the event stops here
      }

      try {
        const messagesQuery = `
          SELECT
            m.messageid,
            m.content,
            m.senderuserid,
            m.createdat,
            u.profileimageurl AS sender_image,
            p.imageurls[1] AS product_image
          FROM messages m
          JOIN users u ON m.senderuserid = u.userid
          JOIN chats c ON m.chatid = c.chatid
          JOIN products p ON c.productid = p.productid
          WHERE m.chatid = $1 AND m.createdat >= $2::date
          ORDER BY m.createdat ASC;
        `;
        const messagesResult = await pool.query(messagesQuery, [chatId, date]);
    
        const formattedMessages = messagesResult.rows.map((message) => ({
          messageId: message.messageid,
          content: message.content,
          senderUserId: message.senderuserid,
          createdAt: message.createdat,
          senderImage: message.sender_image, // sender profile image
          productImage: message.product_image, // product image
          isCurrentUser: message.senderuserid === userId, // Verifies if is current user
        }));
    
        socket.emit('messages_listed', {
          chatId: parseInt(chatId, 10),
          messages: formattedMessages,
        });
      } catch (err: any) {
        console.error('Error fetching messages:', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });

    // Listar conversaciones
    socket.on('listConversations', async () => {

      if (!(await verifyUser(socket, userId))) {
        return; //If token is invalid, the event stops here
      }
      
      try {
        const conversationsQuery = `
          SELECT
            c.chatid,
            c.productid,
            c.buyeruserid,
            c.owneruserid,
            p.name AS product_name,
            p.imageurls[1] AS product_image,
            u_buyer.profileimageurl AS buyer_image,
            u_owner.profileimageurl AS owner_image,
            COALESCE(
              (SELECT m.content
               FROM messages m
               WHERE m.chatid = c.chatid
               ORDER BY m.createdat DESC
               LIMIT 1),
              'No messages yet'
            ) AS last_message,
            COALESCE(
              (SELECT m.createdat
               FROM messages m
               WHERE m.chatid = c.chatid
               ORDER BY m.createdat DESC
               LIMIT 1),
              c.createdat
            ) AS last_message_date
          FROM chats c
          JOIN products p ON c.productid = p.productid
          JOIN users u_buyer ON c.buyeruserid = u_buyer.userid
          JOIN users u_owner ON c.owneruserid = u_owner.userid
          WHERE c.buyeruserid = $1 OR c.owneruserid = $1
          ORDER BY last_message_date DESC;
        `;
        const conversationsResult = await pool.query(conversationsQuery, [userId]);
    
        const formattedConversations = conversationsResult.rows.map((conv) => ({
          chatId: conv.chatid,
          productId: conv.productid,
          productName: conv.product_name,
          productImage: conv.product_image,
          buyerImage: conv.buyer_image,
          ownerImage: conv.owner_image,
          lastMessage: conv.last_message, // Fallback is no needed here
          lastMessageDate: conv.last_message_date, // Fallback is no needed here
          otherUserId: conv.owneruserid === userId ? conv.buyeruserid : conv.owneruserid,
          otherUserImage: conv.owneruserid === userId ? conv.buyer_image : conv.owner_image,
        }));
    
        socket.emit('conversations_listed', {
          message: 'Conversations retrieved successfully',
          conversations: formattedConversations,
        });
      } catch (err: any) {
        console.error('Error fetching conversations:', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Usuario desconectado: ${socket.id}`);
      connectedUsers.delete(userId); // Deletes user from connected users map
    });
  });
};

export default websocketHandlers;
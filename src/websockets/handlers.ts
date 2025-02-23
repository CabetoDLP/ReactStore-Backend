import { Server, Socket } from 'socket.io';
import { pool } from '../db';
import { getUserFromToken } from '../controllers/usersRoutes';
import cookie from 'cookie';

export const websocketHandlers = (io: Server): void => {

  // Definir el mapa de usuarios conectados
  const connectedUsers = new Map<string, string>(); // userId -> socket.id

  const verifyUser = async (socket: Socket, userId: string): Promise<boolean> => {
    const cookies = cookie.parse(socket.request.headers.cookie || '');
    const token = cookies.auth_token;
  
    if (!token) {
      socket.emit('error', { message: 'Unauthorized. Token not found' });
      socket.disconnect(); // Desconectar al usuario
      return false;
    }
  
    const user = getUserFromToken(token);
    if (!user || user.userid !== userId) {
      socket.emit('error', { message: 'Unauthorized. Invalid or expired token' });
      socket.disconnect(); // Desconectar al usuario
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
    
    // Añadir el usuario al mapa de conexiones
    connectedUsers.set(userId, socket.id);

    // Obtener todas las conversaciones del usuario
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

      // Unir al usuario a todas las salas de conversación
      result.rows.forEach((row) => {
        socket.join(`chat_${row.chatid}`);
        console.log(`Usuario ${userId} unido a la conversación ${row.chatid}`);
      });
    });

    socket.on('joinConversation', async ({ chatId }) => {

      if (!(await verifyUser(socket, userId))) {
        return; // Si el token no es válido, el evento se detiene aquí
      }

      try {
        // Obtener los detalles de la conversación, incluyendo las imágenes de perfil de los participantes
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
    
        // Determinar la imagen de perfil del usuario actual y del otro participante
        const isCurrentUserImage = userId === buyeruserid ? buyer_image : owner_image;
        const otherUserImage = userId === buyeruserid ? owner_image : buyer_image;
    
        // Cargar todos los mensajes de la conversación
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
    
        // Verificar si no hay mensajes
        if (messagesResult.rows.length === 0) {
          socket.emit('error', { message: 'No messages found for this chat' });
          return;
        }
    
        // Formatear los mensajes para el cliente
        const formattedMessages = messagesResult.rows.map((message) => ({
          messageId: message.messageid,
          isCurrentUser: message.senderuserid === userId, // Verificar si el mensaje es del usuario actual
          content: message.content,
          createdAt: message.createdat, // Devolver la fecha en su formato original
          senderImage: message.senderuserid === userId ? isCurrentUserImage : otherUserImage, // Asignar la imagen de perfil correcta
        }));
    
        // Enviar mensajes al cliente junto con las imágenes de perfil
        socket.emit('messages_listed', {
          chatId,
          messages: formattedMessages,
          isCurrentUserImage, // Imagen de perfil del usuario actual
          otherUserImage, // Imagen de perfil del otro participante
        });
      } catch (err: any) {
        console.error('Error fetching conversation details:', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });

    // Evento para crear una conversación y enviar un mensaje
    socket.on('createConversationAndMessage', async ({ productid, content }) => {

      if (!(await verifyUser(socket, userId))) {
        return; // Si el token no es válido, el evento se detiene aquí
      }

      try {
        if (!productid || !content) {
          socket.emit('error', { message: 'All data is mandatory' });
          return;
        }

        // Obtener el usuario propietario del producto
        const productQuery = await pool.query('SELECT userid FROM products WHERE productid = $1', [productid]);
        if (productQuery.rows.length === 0) {
          socket.emit('error', { message: 'Product not found' });
          return;
        }

        const owneruserid = productQuery.rows[0].userid;

        // Verificar si la conversación ya existe
        const chatQuery = await pool.query(
          'SELECT chatid, buyeruserid, owneruserid FROM chats WHERE productid = $1 AND (buyeruserid = $2 OR owneruserid = $2)',
          [productid, userId]
        );

        let chatId;
        let buyeruserid;

        if (chatQuery.rows.length === 0) {
          // Evitar que los propietarios creen conversaciones de sus propios productos
          if (userId === owneruserid) {
            socket.emit('error', { message: 'You cannot create a conversation for your own product' });
            return;
          }

          // Crear nueva conversación
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

        // Crear el mensaje asociado a la conversación
        const newMessage = await pool.query(
          'INSERT INTO messages (chatid, senderuserid, content, createdat) VALUES ($1, $2, $3, NOW()) RETURNING *',
          [chatId, userId, content]
        );

        // Formatear la respuesta con `isCurrentUser`
        const formattedMessage = {
          chatId,
          senderUserId: newMessage.rows[0].senderuserid,
          content: newMessage.rows[0].content,
          createdAt: newMessage.rows[0].createdat,
        };

        // Emitir el nuevo mensaje a todos los usuarios en la sala excepto al remitente
        socket.broadcast.to(`chat_${chatId}`).emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: false },
        });

        // Emitir evento al remitente con el mensaje formateado
        socket.emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: true },
        });

        // Identificar al receptor
        const recipientUserId = userId === owneruserid ? buyeruserid : owneruserid;

        // Obtener el socket.id del receptor
        const recipientSocketId = connectedUsers.get(recipientUserId);

        // Obtener la lista actualizada de conversaciones para el receptor
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

        // Emitir la lista actualizada de conversaciones al receptor
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('conversations_listed', {
            message: 'Conversations retrieved successfully',
            conversations: formattedConversations,
          });
        }

        // Confirmación de activación del evento
        socket.emit('event_confirmation', {
          message: 'Event createConversationAndMessage triggered successfully',
        });
        socket.emit('listConversations');
      } catch (err: any) {
        console.error('Error while creating message: ', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });

    // Evento para enviar un mensaje a una conversación existente
    socket.on('sendMessage', async ({ chatId, content }) => {

      try {
        if (!chatId || !content) {
          socket.emit('error', { message: 'All data is mandatory' });
          return;
        }

        // Verificar si la conversación existe y el usuario es parte de ella
        const chatQuery = await pool.query(
          'SELECT buyeruserid, owneruserid FROM chats WHERE chatid = $1 AND (buyeruserid = $2 OR owneruserid = $2)',
          [chatId, userId]
        );

        if (chatQuery.rows.length === 0) {
          socket.emit('error', { message: 'Conversation not found or unauthorized' });
          return;
        }

        const { buyeruserid, owneruserid } = chatQuery.rows[0];

        // Crear el mensaje asociado a la conversación
        const newMessage = await pool.query(
          'INSERT INTO messages (chatid, senderuserid, content, createdat) VALUES ($1, $2, $3, NOW()) RETURNING *',
          [chatId, userId, content]
        );

        // Formatear la respuesta con `isCurrentUser`
        const formattedMessage = {
          chatId,
          senderUserId: newMessage.rows[0].senderuserid,
          content: newMessage.rows[0].content,
          createdAt: newMessage.rows[0].createdat,
        };

        // Emitir el nuevo mensaje a todos los usuarios en la sala excepto al remitente
        socket.broadcast.to(`chat_${chatId}`).emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: false },
        });

        // Emitir evento al remitente con el mensaje formateado
        socket.emit('message_created', {
          message: 'Message sent successfully',
          data: { ...formattedMessage, isCurrentUser: true },
        });

        // Identificar al receptor
        const recipientUserId = userId === owneruserid ? buyeruserid : owneruserid;

        // Obtener el socket.id del receptor
        const recipientSocketId = connectedUsers.get(recipientUserId);

        // Obtener la lista actualizada de conversaciones para el receptor
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

        // Emitir la lista actualizada de conversaciones al receptor
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('conversations_listed', {
            message: 'Conversations retrieved successfully',
            conversations: formattedConversations,
          });
        }

        // Confirmación de activación del evento
        socket.emit('event_confirmation', {
          message: 'Event sendMessage triggered successfully',
        });
        socket.emit('listConversations');
      } catch (err: any) {
        console.error('Error while creating message: ', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });
    
    // Listar mensajes de una conversación
    socket.on('listMessages', async ({ chatId, date }) => {

      if (!(await verifyUser(socket, userId))) {
        return; // Si el token no es válido, el evento se detiene aquí
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
          senderImage: message.sender_image, // Imagen del remitente
          productImage: message.product_image, // Imagen del producto
          isCurrentUser: message.senderuserid === userId, // Verifica si es el usuario actual
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
        return; // Si el token no es válido, el evento se detiene aquí
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
          lastMessage: conv.last_message, // Ya no necesitamos el fallback aquí
          lastMessageDate: conv.last_message_date, // Ya no necesitamos el fallback aquí
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
      connectedUsers.delete(userId); // Eliminar al usuario del mapa
    });
  });
};

export default websocketHandlers;
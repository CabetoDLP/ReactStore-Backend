import { Server, Socket } from 'socket.io';
import { pool } from '../db';
import { getUserFromToken } from '../controllers/usersRoutes';
import cookie from 'cookie';

export const websocketHandlers = (io: Server): void => {
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

    // Unirse a una sala específica para la conversación
    socket.on('joinConversation', async ({chatId, date}) => {
      socket.join(`chat_${chatId}`);

      // Validar que la fecha sea válida
      const parsedDate = new Date(date);
      if (isNaN(parsedDate.getTime())) {
        socket.emit('error', { message: 'Invalid date format' });
        return;
      }

      // Cargar mensajes anteriores de la base de datos
      const messagesResult = await pool.query(`
        SELECT
            messageid,
            content,
            senderuserid,
            createdat
          FROM messages
          WHERE chatid = $1 AND createdat >= $2::date
          ORDER BY createdat ASC;`, [chatId, parsedDate]);

      // Verificar si no hay mensajes
      if (messagesResult.rows.length === 0) {
        socket.emit('error', { message: 'No messages found for this chat' });
        return;
      }
  
      // Formatear los mensajes para el cliente
      const formattedMessages = messagesResult.rows.map((message) => ({
        messageId: message.messageid,
        isCurrentUser: message.senderuserid === userId, // userId debe ser accesible
        content: message.content,
        createdAt: message.createdat, // Devolver la fecha en su formato original
      }));
      
      // Enviar mensajes anteriores al cliente
      socket.emit('messages_listed', {
        chatId,
        messages: formattedMessages,
      });
    });

    socket.on('createMessage', async ({ productid, content }) => {
      try {
        if (!productid || !content) {
          socket.emit('error', { message: 'All data is mandatory' });
          return;
        }
    
        console.log(productid, content);
    
        // Obtener el usuario propietario del producto
        const productQuery = await pool.query('SELECT userid FROM products WHERE productid = $1', [productid]);
        if (productQuery.rows.length === 0) {
          socket.emit('error', { message: 'Product not found' });
          return;
        }
    
        const owneruserid = productQuery.rows[0].userid;
    
        // Verificar si la conversación ya existe
        const chatQuery = await pool.query(
          'SELECT chatid FROM chats WHERE productid = $1 AND (buyeruserid = $2 OR owneruserid = $2)',
          [productid, userId]
        );
    
        let chatId;
    
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
        } else {
          chatId = chatQuery.rows[0].chatid;
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
    
        // Confirmación de activación del evento
        socket.emit('event_confirmation', {
          message: 'Event createMessage triggered successfully',
        });
      } catch (err: any) {
        console.error('Error while creating message: ', err.message);
        socket.emit('error', { message: 'Internal server error', error: err.message });
      }
    });
    
    // Listar mensajes de una conversación
    socket.on('listMessages', async ({ chatId, date }) => {
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
            m.content AS last_message,
            m.createdat AS last_message_date
          FROM chats c
          JOIN products p ON c.productid = p.productid
          JOIN users u_buyer ON c.buyeruserid = u_buyer.userid
          JOIN users u_owner ON c.owneruserid = u_owner.userid
          LEFT JOIN LATERAL (
            SELECT content, createdat
            FROM messages
            WHERE chatid = c.chatid
            ORDER BY createdat DESC
            LIMIT 1
          ) m ON true
          WHERE c.buyeruserid = $1 OR c.owneruserid = $1
          ORDER BY m.createdat DESC NULLS LAST, c.createdat DESC;
        `;
        const conversationsResult = await pool.query(conversationsQuery, [userId]);
    
        const formattedConversations = conversationsResult.rows.map((conv) => ({
          chatId: conv.chatid,
          productId: conv.productid,
          productName: conv.product_name,
          productImage: conv.product_image,
          buyerImage: conv.buyer_image,
          ownerImage: conv.owner_image,
          lastMessage: conv.last_message || 'No messages yet',
          lastMessageDate: conv.last_message_date || conv.createdat,
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
    });
  });
};

export default websocketHandlers;
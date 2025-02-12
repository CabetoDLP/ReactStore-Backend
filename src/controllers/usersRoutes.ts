import { Router, Request, Response } from 'express';
import { pool } from '../db';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { corsOptions } from '../app';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

const router = Router();
const bcrypt = require('bcryptjs');
const jwtSecret = process.env.JWT_SECRET as string;

if (!jwtSecret) {
  console.error('JWT_SECRET is not defined');
  process.exit(1);  // Esto detendría la ejecución si no se define JWT_SECRET
}

router.use(cookieParser());


// Configuración de multer para manejar uploads
const upload = multer({
  limits: {
    fileSize: process.env.MAX_FILE_SIZE as unknown as number//5 * 1024 * 1024 // 5MB limit
  },
  dest: 'uploads/'
});// 'images' es el campo del formulario

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, //'dzipy5bme'
  api_key: process.env.CLOUDINARY_API_KEY, //'763235895277341'
  api_secret: process.env.CLOUDINARY_API_SECRET, //'dg_y8rJuUsMtT65Jt7lfMBCD4vk'
  secure: true,
});

//Interfaces
interface User {
  name: string;
  lastName: string;
  email: string;
  password: string;
}

interface UserAuth {
  email: string;
  password: string;
}

interface Product {
  name: string;
  description: string;
  price: number;
  stock: number;
  categoryid: number;
}

interface UserProduct {
  productid: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  categoryid: number;
}

interface ProductReference {
  productid: string;
}

interface CartProduct {
  productid: string;
  quantity: number;
}

interface Filters {
  name: string;
  category: string;
}

interface JwtPayload {
  userid: string;  // Aseguramos que el payload contiene un 'userid' como string
}

export function getUserFromToken(token: string): JwtPayload | null {
  try {
    // Aquí hacemos una "type assertion" para decirle a TypeScript que el token será de tipo JwtPayloadWithUserId
    const decoded: JwtPayload = jwt.verify(token, jwtSecret) as JwtPayload;

    // Comprobar si el token contiene un `userid` y si es válido
    if (!decoded.userid) {
      throw new Error('Token does not contain a valid user ID');
    }

    return decoded;  // Devolvemos el payload decodificado
  } catch (error) {
    console.error('Token is invalid or expired', error);
    return null;  // Si el token es inválido o no contiene `userid`, devolvemos null
  }
}

//USERS

//Register
router.post('/users/register', cors(corsOptions), upload.single('image'), async (req: Request<{}, {}, User>, res: Response) => {
  try {
    const userid = uuidv4();
    const { name, lastName, email, password } = req.body;

    // Validar los campos del usuario
    if (!name || !lastName || !email || !password) {
      res.status(400).json({ message: 'All user data is mandatory' });
      return;
    }

    // Verificar si el correo ya existe en la base de datos
    const emailCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (emailCheck.rows.length > 0) {
      res.status(409).json({ message: 'El correo ya está registrado' });
      return;
    }

    // Verificar si la imagen fue proporcionada
    const file = req.file;
    if (!file) {
      res.status(400).json({ message: 'Profile image is required' });
      return;
    }

    // Subir la imagen a Cloudinary
    const userFolder = process.env.USER_FOLDER as string; //`ReactStore/Users`;
    const imageUploadResult = await cloudinary.uploader.upload(file.path, {
      folder: userFolder,
      public_id: userid, // Nombre basado en el identificador del usuario
      format: 'webp',
    });

    const profileImageUrl = imageUploadResult.secure_url;

    // Hashear la contraseña
    const hashedPassword: string = await bcrypt.hash(password, 10);

    // Crear el usuario en la base de datos
    const createdAccount = await pool.query(
      'INSERT INTO users (userid, name, lastName, email, password, profileimageurl, createdAt) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
      [userid, name, lastName, email, hashedPassword, profileImageUrl]
    );

    // Responder con el usuario creado
    res.status(201).json({
      message: 'User registered successfully',
      user: createdAccount.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while signing up user: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});


//Login
router.post('/users/login', async (req: Request<{}, {}, UserAuth>, res: Response) => {
  try {
    const { email, password } = req.body;

    // Verifies user data
    if (!email || !password) {
      res.status(400).json({ message: 'All data is mandatory' });
      return;
    }

    // Verifies if the user exists
    const accountCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (accountCheck.rows.length === 0) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    // Validates password
    const isPasswordValid = await bcrypt.compare(password, accountCheck.rows[0].password);

    if (!isPasswordValid) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    // Creates the JSON Web Token (JWT)
    const token = jwt.sign(
      { userid: accountCheck.rows[0].userid },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN } // '1h'
    );

    // Configures the cookie
    res.cookie('auth_token', token, {
      httpOnly: true, // Prevents JavaScript access
      secure: false, // Only sent over HTTPS in production
      sameSite: 'none', // Prevents CSRF
      maxAge: process.env.COOKIE_MAX_AGE as unknown as number, // 1 hour
    });

    // Successful response
    res.status(200).json({ message: 'Successful login' });
  } catch (err: any) {
    console.error('Error logging in user:', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//PRODUCTS

//Create a product
router.post('/products/create', upload.array('images', 5), async (req: Request<{}, {}, Product>, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }
    console.log(req.body);
    console.log(req.files);
    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    const productid = uuidv4(); // Generate product UUID
    const { name, description, price, stock, categoryid } = req.body;

    // Validate request body fields
    if (!name || !description || !price || !stock || !categoryid) {
      res.status(400).json({ message: 'All data is mandatory' });
      return;
    }

    // Validate images
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0 || files.length > 5) {
      res.status(400).json({ message: 'The image quantity allowed is between 1 and 5' });
      return;
    }

    const productFolder = process.env.PRODUCT_FOLDER + "/" + productid; // `ReactStore/Products/${productid}`;

    // Upload images to Cloudinary and generate URLs
    const imageUploadPromises = files.map((file, index) =>
      cloudinary.uploader.upload(file.path, {
        folder: productFolder,
        public_id: `${productid}-${index}`, // Ensure unique public_id for each image
        format: 'webp',
      })
    );

    const imageUploadResults = await Promise.all(imageUploadPromises);
    const imageUrls = imageUploadResults.map((result) => result.secure_url);

    // Format image URLs as PostgreSQL array
    const imageUrlsArray = `{${imageUrls.join(',')}}`;

    // Insert product into database
    const createdProduct = await pool.query(
      'INSERT INTO products (productid, name, description, price, stock, categoryid, userid, imageurls, isactive, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW()) RETURNING *',
      [productid, name, description, price, stock, categoryid, userid, imageUrlsArray]
    );

    // Respond with created product
    res.status(201).json({
      message: 'Product created successfully',
      product: createdProduct.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while creating product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//Edit a product
router.post('/products/update', upload.array('images', 5), async (req: Request<{}, {}, UserProduct>, res: Response) => {
  try {
    const token = req.cookies.auth_token;
    
    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }
    console.log(req.body);
    console.log(req.files);
    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    const {productid, name, description, price, stock, categoryid } = req.body;

    console.log(req.body);
    // Validate request body fields
    if (!productid || !name || !description || !price || !stock || !categoryid) {
      res.status(400).json({ message: 'All data is mandatory' });
      return;
    }

    // Validate images
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0 || files.length > 5) {
      res.status(400).json({ message: 'The image quantity allowed is between 1 and 5' });
      return;
    }

    //If product doesn't exist
    const exists = await pool.query('SELECT 1 FROM products WHERE productid = $1 AND userid = $2 LIMIT 1', [productid, userid]);
    if (!exists) {
      res.status(400).json({ message: `the product doesn't exists or the user doesn't own the product` });
      return;
    }

    const productFolder = `ReactStore/Products/${productid}`;

    // Upload images to Cloudinary and generate URLs
    const imageUploadPromises = files.map((file, index) =>
      cloudinary.uploader.upload(file.path, {
        folder: productFolder,
        public_id: `${productid}-${index}`, // Ensure unique public_id for each image
        format: 'webp',
      })
    );

    const imageUploadResults = await Promise.all(imageUploadPromises);
    const imageUrls = imageUploadResults.map((result) => result.secure_url);

    
    // Format image URLs as PostgreSQL array
    const imageUrlsArray = `{${imageUrls.join(',')}}`;

    const updatedProduct = await pool.query(
      'UPDATE products set name = $3, description = $4, price = $5, stock = $6, categoryid = $7, imageurls = $8 WHERE productid = $1 AND userid = $2 RETURNING *',
      [productid, userid, name, description, price, stock, categoryid, imageUrlsArray]
    );


    // Respond with created product
    res.status(201).json({
      message: 'Product created successfully',
      product: updatedProduct.rows[0],
    });

  } catch (err: any) {
    console.error('Error occurred while updating product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//Delete
router.post('/products/delete', async (req: Request<{}, {}, ProductReference>, res: Response) => {
  try {
    const token = req.cookies.auth_token;
    
    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }
    console.log(req.body);
    console.log(req.files);
    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    const {productid} = req.body;

    console.log(req.body);
    // Validate request body fields
    if (!productid) {
      res.status(400).json({ message: 'All data is mandatory' });
      return;
    }

    const deletedProduct = await pool.query(
      'UPDATE products set isactive = FALSE WHERE productid = $1 AND userid = $2 RETURNING *',
      [productid, userid]
    );

    if(!deletedProduct){
      res.status(404).json({ message: "No product found." });
      return;
    }

    // Respond with created product
    res.status(201).json({
      message: 'Product deleted successfully',
      product: deletedProduct.rows[0],
    });

  } catch (err: any) {
    console.error('Error occurred while creating product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//View a product
router.post('/products/showProduct', async (req: Request<{}, {}, ProductReference>, res: Response) => {
  try {
    const { productid } = req.body;

    // Validates data from request body
    if (!productid) {
      res.status(400).json({ message: 'Product reference is mandatory' });
      return;
    }

    //Consult all product public information
    const selectedProduct = await pool.query(
      'SELECT productid, name, description, price, stock, imageurls, productcategories.category AS category, productcategories.categoryid AS categoryid FROM products INNER JOIN productcategories ON products.categoryid = productcategories.categoryid WHERE productid = $1 and isactive = TRUE', 
      [productid]
    );

    // Responder con el producto creado
    res.status(201).json({
      message: 'Product created successfully',
      product: selectedProduct.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while consulting product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//View user's products
router.get('/products/showUserProducts', async (req: Request<{}, {}>, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    // Validates data from request body
    if (!userid) {
      res.status(400).json({ message: 'User reference is mandatory' });
      return;
    }

    //Consult all product public information
    const userProducts = await pool.query(
      'SELECT productid, name, price, imageurls FROM products WHERE userid = $1 and isactive = TRUE', 
      [userid]
    );

    // Responder con el producto creado
    res.status(201).json({
      message: 'User products',
      product: userProducts.rows,
    });
  } catch (err: any) {
    console.error('Error occurred while consulting product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});
// Add to cart
router.post('/products/alterProductToCart', async (req: Request<{}, {}, CartProduct>, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    // Validar la existencia del token
    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    const { productid, quantity } = req.body;

    // Validar los campos del cuerpo de la solicitud
    if (!productid || quantity == null || quantity < 0) {
      res.status(400).json({ message: 'All data is mandatory and quantity must be non-negative' });
      return;
    }

    const cartProductid = uuidv4(); // Generar ID único para el producto en el carrito

    // Verificar si el producto ya existe en el carrito del usuario
    const cartProductExists = await pool.query(
      'SELECT 1 FROM usercartproducts WHERE productid = $1 AND userid = $2 AND isactive = TRUE',
      [productid, userid]
    );

    let cartProduct;

    if (cartProductExists.rows.length > 0) {
      // Actualizar la cantidad o desactivar el producto si la cantidad es 0
      if (quantity === 0) {
        cartProduct = await pool.query(
          'UPDATE usercartproducts SET quantity = $3, isactive = FALSE WHERE productid = $1 AND userid = $2 RETURNING *',
          [productid, userid, quantity]
        );
      } else {
        cartProduct = await pool.query(
          'UPDATE usercartproducts SET quantity = $3 WHERE productid = $1 AND userid = $2 RETURNING *',
          [productid, userid, quantity]
        );
      }
    } else {
      // Insertar un nuevo producto en el carrito
      cartProduct = await pool.query(
        'INSERT INTO usercartproducts (cartproductid, userid, productid, quantity, isactive, createdat) VALUES ($1, $2, $3, $4, TRUE, NOW()) RETURNING *',
        [cartProductid, userid, productid, quantity]
      );
    }

    // Responder con el producto alterado
    res.status(201).json({
      message: 'Product altered on cart successfully',
      cartProduct: cartProduct.rows[0],
    });
    return;
  } catch (err: any) {
    console.error('Error occurred while altering product on cart: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
    return;
  }
});


//Delete from cart
router.post('/cart/deleteProduct', async (req: Request<{}, {}, ProductReference>, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    const { productid} = req.body;

    // Validar los campos del cuerpo de la solicitud
    if (!productid) {
      res.status(400).json({ message: 'All data is mandatory' });
      return;
    }

    const cartProductExists = await pool.query(
      'SELECT 1 FROM usercartproducts WHERE productid = $1 AND userid = $2 AND isactive = TRUE',
      [productid, userid]
    );
    
    let cartProduct;
    
    if(!(cartProductExists.rows.length)){
      res.status(404).json({
        message: 'Product not found',
      });
    }

    cartProduct = await pool.query(
      'UPDATE usercartproducts SET quantity = 0, isactive = FALSE WHERE productid = $1 AND userid = $2 RETURNING *',
      [productid, userid]
    );

    // Responder con el producto creado
    res.status(201).json({
      message: 'Product altered on cart successfully',
      cartProduct: cartProduct.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while altering product on cart: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//Show user's cart products
router.get('/cart/showUserProducts', async (req: Request<{}, {}>, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    const userCartProducts = await pool.query(
      'SELECT usercartproducts.cartproductid, products.productid, products.name, usercartproducts.quantity, products.price, products.imageurls[1] AS imageurl FROM usercartproducts INNER JOIN products ON usercartproducts.productid = products.productid WHERE usercartproducts.userid = $1 AND usercartproducts.isactive = TRUE AND products.isactive = TRUE',
      [userid]
    );
    
    let cartProduct;

    if(!userCartProducts){
      res.status(404).json({ message: "No products at user`s cart have been found." });
      return;
    }

    // Responder con el producto creado
    res.status(200).json({
      message: 'cart products showed succesfully',
      cartProducts: userCartProducts.rows,
    });
  } catch (err: any) {
    console.error(`Error occurred while consulting user's cart products:` , err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//Buy products from user cart
router.get('/cart/buyProducts', async (req: Request<{}, {}>, res: Response) => {
  const client = await pool.connect(); // Obtener conexión del pool
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    // Iniciar la transacción
    await client.query('BEGIN');

    // Listar los productos del carrito del usuario
    const userCartProducts = await client.query(
      'SELECT cartproductid, productid, quantity FROM usercartproducts WHERE userid = $1 AND isactive = TRUE',
      [userid]
    );

    if (userCartProducts.rows.length === 0) {
      res.status(400).json({ message: 'There are no products in the cart' });
      await client.query('ROLLBACK'); // Revertir la transacción
      return;
    }

    for (const cartProduct of userCartProducts.rows) {
      const { productid, quantity } = cartProduct;

      // Verificar stock del producto
      const product = await client.query(
        'SELECT stock FROM products WHERE productid = $1 AND isactive = TRUE',
        [productid]
      );

      if (product.rows.length === 0 || product.rows[0].stock < quantity) {
        res.status(422).json({ message: `Insufficient stock for product ID: ${productid}` });
        await client.query('ROLLBACK'); // Revertir la transacción
        return;
      }

      // Reducir el stock del producto
      await client.query(
        `UPDATE products SET stock = stock - $1 WHERE productid = $2`,
        [quantity, productid]
      );
    }

    // Insertar los productos del carrito en purchasedproducts
    for (const cartProduct of userCartProducts.rows) {
      const purchasedProductId = uuidv4();
      await client.query(
        'INSERT INTO purchasedproducts (purchasedproductid, productid, quantity, isactive, createdat) VALUES ($1, $2, $3, TRUE, NOW())',
        [purchasedProductId, cartProduct.productid, cartProduct.quantity]
      );
    }

    // Desactivar los productos del carrito
    await client.query(
      'UPDATE usercartproducts SET isactive = FALSE WHERE userid = $1 AND isactive = TRUE',
      [userid]
    );

    // Confirmar la transacción
    await client.query('COMMIT');
    res.status(200).json({ message: 'Purchase completed successfully' });
  } catch (err: any) {
    await client.query('ROLLBACK'); // Revertir la transacción en caso de error
    console.error('Error occurred while buying products: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  } finally {
    client.release(); // Liberar la conexión
  }
});

//View a product
router.get('/purchases/showPurchasedProducts', async (req: Request<{}, {}>, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    //Consult all product public information
    const purchasedProducts = await pool.query(
      'SELECT purchasedproducts.productid AS productid, products.name AS name, purchasedproducts.quantity AS quantity, products.price AS price, products.imageurls[1] AS imageurl, purchasedproducts.createdat AS createdat FROM purchasedproducts INNER JOIN products ON purchasedproducts.productid = products.productid'
    );

    // Responder con el producto creado
    res.status(200).json({
      message: 'Listed purchased products',
      purchasedProducts: purchasedProducts.rows,
    });
  } catch (err: any) {
    console.error('Error occurred while consulting categories: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

//View a product
router.get('/products/showCategories', async (req: Request<{}, {}>, res: Response) => {
  try {

    //Consult all product public information
    const productCategories = await pool.query(
      'SELECT categoryid, category FROM productcategories'
    );

    // Responder con el producto creado
    res.status(200).json({
      message: 'Listed product categories',
      categories: productCategories.rows,
    });
  } catch (err: any) {
    console.error('Error occurred while consulting categories: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

router.post("/products/list", async (req: Request, res: Response) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }
    console.log(req.body);
    console.log(req.files);
    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }
    
    // Obtén el filtro desde el cuerpo de la solicitud
    const { filter } = req.body;

    // Validar que el filtro sea proporcionado
    if (!filter) {
      res.status(400).json({ message: "Filter is required." });
      return;
    }

    // Log para verificar el filtro recibido
    console.log("Filter received:", filter);

    // Ejecuta la consulta con los parámetros
    const products = await pool.query(`
      SELECT productid, name, price, imageurls 
      FROM products 
      WHERE name ILIKE $1 AND isactive = TRUE AND userid != $2
    `, [filter, userid]);

    // Validar si no hay resultados
    if (products.rows.length === 0) {
      res.status(404).json({ message: "No products found." });
      return;
    }

    // Retornar los productos encontrados
    res.json(products.rows);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).json({ error: "Error searching for products" });
  }
});





export default router;
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
import nodemailer from 'nodemailer'; // Import Nodemailer to send emails
dotenv.config();

const router = Router();
const bcrypt = require('bcryptjs');
const jwtSecret = process.env.JWT_SECRET as string;

if (!jwtSecret) {
  console.error('JWT_SECRET is not defined');
  process.exit(1);  // This will stop execution if JWT_SECRET is not defined
}

router.use(cookieParser());

// Multer configuration for handling uploads
const upload = multer({
  limits: {
    fileSize: process.env.MAX_FILE_SIZE as unknown as number // 5 * 1024 * 1024 // 5MB limit
  },
  dest: 'uploads/'
}); // 'images' is the form field

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Interfaces
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

interface UserCodeAuth {
  email: string;
  code: string;
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

interface JwtPayload {
  userid: string;  // Ensure the payload contains a 'userid' as a string
}

export function getUserFromToken(token: string): JwtPayload | null {
  try {
    // Here we make a "type assertion" to tell TypeScript that the token will be of type JwtPayloadWithUserId
    const decoded: JwtPayload = jwt.verify(token, jwtSecret) as JwtPayload;

    // Check if the token contains a `userid` and if it is valid
    if (!decoded.userid) {
      throw new Error('Token does not contain a valid user ID');
    }

    return decoded;  // Return the decoded payload
  } catch (error) {
    console.error('Token is invalid or expired', error);
    return null;  // If the token is invalid or does not contain `userid`, return null
  }
}

// USERS

// Configure Nodemailer transport
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use Gmail or any other service
  auth: {
    user: process.env.EMAIL_USER, // Your email
    pass: process.env.EMAIL_APP_PASSWORD, // Your password
  },
});

router.post('/users/register', cors(corsOptions), upload.single('image'), async (req: Request<{}, {}, User>, res: Response) => {
  try {
    const userid = uuidv4();
    const { name, lastName, email, password } = req.body;

    // Validate user fields
    if (!name || !lastName || !email || !password) {
      res.status(400).json({ message: 'All user data is mandatory' });
      return;
    }

    // Check if the email already exists in the database
    const emailCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (emailCheck.rows.length > 0) {
      res.status(409).json({ message: 'Email is already registered' });
      return;
    }

    // Check if the image was provided
    const file = req.file;
    if (!file) {
      res.status(400).json({ message: 'Profile image is required' });
      return;
    }

    // Upload the image to Cloudinary
    const userFolder = process.env.USER_FOLDER as string; // `ReactStore/Users`;
    const imageUploadResult = await cloudinary.uploader.upload(file.path, {
      folder: userFolder,
      public_id: userid, // Name based on the user's identifier
      format: 'webp',
    });

    const profileImageUrl = imageUploadResult.secure_url;

    // Hash the password
    const hashedPassword: string = await bcrypt.hash(password, 10);

    // Generate verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000); // 6-digit code

    // Send the verification code via email
    const mailOptions = {
      to: email, // User's email
      subject: 'Verification code', // Email subject
      html: `
        <p>Your verification code is: <strong>${verificationCode}</strong></p>
        <p>You can verify your account using the following link:</p>
        <p>
          <a href="${process.env.WEBSITE_FRONTEND_HOSTNAME}/userVerity?email=${email}" target="_blank" rel="noopener noreferrer">
            Verify your account
          </a>
        </p>
      `,
    };

    // Attempt to send the email
    await transporter.sendMail(mailOptions);

    // If the email is sent successfully, register the user in the database
    const createdAccount = await pool.query(
      'INSERT INTO users (userid, name, lastname, email, password, profileimageurl, createdat, verification_code, is_verified) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) RETURNING *',
      [userid, name, lastName, email, hashedPassword, profileImageUrl, verificationCode, false] // is_verified = false
    );

    // Respond with the created user
    res.status(201).json({
      message: 'User registered successfully. Please check your email to verify your account.',
      user: createdAccount.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while signing up user: ', err.message);

    // If there is an error sending the email, do not register the user
    res.status(500).json({ message: 'Error sending verification email. User not registered.', error: err.message });
  }
});

router.post('/users/verify', async (req: Request<{}, {}, UserCodeAuth>, res: Response) => {
  try {
    const { email, code } = req.body;

    // Validate fields
    if (!email || !code) {
      res.status(400).json({ message: 'Email and verification code are required' });
      return;
    }

    // Convert code to number
    const verificationCode = parseInt(code, 10);
    if (isNaN(verificationCode)) {
      res.status(400).json({ message: 'Invalid verification code format' });
      return;
    }

    // Find user by email
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (user.rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }

    // Verify the code (compare as number)
    if (user.rows[0].verification_code === verificationCode) {
      // Mark the account as verified
      await pool.query('UPDATE users SET is_verified = true WHERE email = $1', [email]);

      res.status(200).json({ message: 'Account verified successfully' });
    } else {
      res.status(400).json({ message: 'Invalid verification code' });
    }
  } catch (err: any) {
    console.error('Error occurred while verifying user: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// Login
router.post('/users/login', async (req: Request<{}, {}, UserAuth>, res: Response) => {
  try {
    const { email, password } = req.body;

    // Validate user data
    if (!email || !password) {
      res.status(400).json({ message: 'All data is mandatory' });
      return;
    }

    // Check if the user exists
    const accountCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (accountCheck.rows.length === 0) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    const user = accountCheck.rows[0];

    // Check if the account is verified
    if (!user.is_verified) {
      res.status(403).json({ message: 'Account not verified. Please verify your account before logging in.' });
      return;
    }

    // Validate the password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    // Create JSON Web Token (JWT)
    const token = jwt.sign(
      { userid: user.userid },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN } // '1h'
    );

    // Set the cookie
    res.cookie('auth_token', token, {
      httpOnly: process.env.NODE_ENV === 'production', // Prevent access from JavaScript
      secure: process.env.NODE_ENV === 'production', // Only works over HTTPS in production
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Prevent CSRF
      maxAge: process.env.COOKIE_MAX_AGE as unknown as number, // 1 hour
    });

    // Successful response
    res.status(200).json({ message: 'Successful login' });
  } catch (err: any) {
    console.error('Error logging in user:', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// PRODUCTS

// Create a product
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

// Edit a product
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

    // If product doesn't exist
    const exists = await pool.query('SELECT 1 FROM products WHERE productid = $1 AND userid = $2 LIMIT 1', [productid, userid]);
    if (!exists) {
      res.status(400).json({ message: `The product doesn't exist or the user doesn't own the product` });
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
      message: 'Product updated successfully',
      product: updatedProduct.rows[0],
    });

  } catch (err: any) {
    console.error('Error occurred while updating product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// Delete
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
    console.error('Error occurred while deleting product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// View a product
router.post('/products/showProduct', async (req: Request<{}, {}, ProductReference>, res: Response) => {
  try {
    const { productid } = req.body;

    // Validate data from request body
    if (!productid) {
      res.status(400).json({ message: 'Product reference is mandatory' });
      return;
    }

    // Query all public product information
    const selectedProduct = await pool.query(
      'SELECT productid, name, description, price, stock, imageurls, productcategories.category AS category, productcategories.categoryid AS categoryid FROM products INNER JOIN productcategories ON products.categoryid = productcategories.categoryid WHERE productid = $1 and isactive = TRUE', 
      [productid]
    );

    // Respond with the created product
    res.status(201).json({
      message: 'Product created successfully',
      product: selectedProduct.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while consulting product: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// View user's products
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

    // Validate data from request body
    if (!userid) {
      res.status(400).json({ message: 'User reference is mandatory' });
      return;
    }

    // Query all public product information
    const userProducts = await pool.query(
      'SELECT productid, name, price, imageurls FROM products WHERE userid = $1 and isactive = TRUE', 
      [userid]
    );

    // Respond with the created product
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

    // Validate token existence
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

    // Validate request body fields
    if (!productid || quantity == null || quantity < 0) {
      res.status(400).json({ message: 'All data is mandatory and quantity must be non-negative' });
      return;
    }

    const cartProductid = uuidv4(); // Generate unique ID for the product in the cart

    // Check if the product already exists in the user's cart
    const cartProductExists = await pool.query(
      'SELECT 1 FROM usercartproducts WHERE productid = $1 AND userid = $2 AND isactive = TRUE',
      [productid, userid]
    );

    let cartProduct;

    if (cartProductExists.rows.length > 0) {
      // Update the quantity or deactivate the product if the quantity is 0
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
      // Insert a new product into the cart
      cartProduct = await pool.query(
        'INSERT INTO usercartproducts (cartproductid, userid, productid, quantity, isactive, createdat) VALUES ($1, $2, $3, $4, TRUE, NOW()) RETURNING *',
        [cartProductid, userid, productid, quantity]
      );
    }

    // Respond with the altered product
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


// Delete from cart
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

    // Validate request body fields
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

    // Respond with the created product
    res.status(201).json({
      message: 'Product altered on cart successfully',
      cartProduct: cartProduct.rows[0],
    });
  } catch (err: any) {
    console.error('Error occurred while altering product on cart: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// Show user's cart products
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

    // Query to get cart products with product details and available stock
    const userCartProducts = await pool.query(
      `SELECT 
        usercartproducts.cartproductid, 
        products.productid, 
        products.name, 
        usercartproducts.quantity, 
        products.price, 
        products.imageurls[1] AS imageurl, 
        products.stock AS max_available_quantity 
      FROM usercartproducts 
      INNER JOIN products 
        ON usercartproducts.productid = products.productid 
      WHERE usercartproducts.userid = $1 
        AND usercartproducts.isactive = TRUE 
        AND products.isactive = TRUE`,
      [userid]
    );

    if (!userCartProducts.rows.length) {
      res.status(204).json({
        message: "No products at user's cart have been found.",
        cartProducts: userCartProducts.rows, 
      });
      return;
    }

    // Respond with the cart products and their maximum available quantity
    res.status(200).json({
      message: 'Cart products showed successfully',
      cartProducts: userCartProducts.rows,
    });
  } catch (err: any) {
    console.error(`Error occurred while consulting user's cart products:`, err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// Buy products from user cart
router.get('/cart/buyProducts', async (req: Request<{}, {}>, res: Response) => {
  const client = await pool.connect(); // Get connection from the pool
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

    // Start the transaction
    await client.query('BEGIN');

    // List the products in the user's cart
    const userCartProducts = await client.query(
      'SELECT cartproductid, productid, quantity FROM usercartproducts WHERE userid = $1 AND isactive = TRUE',
      [userid]
    );

    if (userCartProducts.rows.length === 0) {
      res.status(400).json({ message: 'There are no products in the cart' });
      await client.query('ROLLBACK'); // Rollback the transaction
      return;
    }

    for (const cartProduct of userCartProducts.rows) {
      const { productid, quantity } = cartProduct;

      // Check product stock
      const product = await client.query(
        'SELECT stock FROM products WHERE productid = $1 AND isactive = TRUE',
        [productid]
      );

      if (product.rows.length === 0 || product.rows[0].stock < quantity) {
        res.status(422).json({ message: `Insufficient stock for product ID: ${productid}` });
        await client.query('ROLLBACK'); // Rollback the transaction
        return;
      }

      // Reduce the product stock
      await client.query(
        `UPDATE products SET stock = stock - $1 WHERE productid = $2`,
        [quantity, productid]
      );
    }

    // Insert the cart products into purchasedproducts
    for (const cartProduct of userCartProducts.rows) {
      const purchasedProductId = uuidv4();
      await client.query(
        'INSERT INTO purchasedproducts (purchasedproductid, productid, quantity, isactive, createdat) VALUES ($1, $2, $3, TRUE, NOW())',
        [purchasedProductId, cartProduct.productid, cartProduct.quantity]
      );
    }

    // Deactivate the cart products
    await client.query(
      'UPDATE usercartproducts SET isactive = FALSE WHERE userid = $1 AND isactive = TRUE',
      [userid]
    );

    // Commit the transaction
    await client.query('COMMIT');
    res.status(200).json({ message: 'Purchase completed successfully' });
  } catch (err: any) {
    await client.query('ROLLBACK'); // Rollback the transaction in case of error
    console.error('Error occurred while buying products: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  } finally {
    client.release(); // Release the connection
  }
});

// View purchased products
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

    // Query purchased products for the specific user
    const purchasedProducts = await pool.query(
      `SELECT 
         purchasedproducts.productid AS productid, 
         products.name AS name, 
         purchasedproducts.quantity AS quantity, 
         products.price AS price, 
         products.imageurls[1] AS imageurl, 
         purchasedproducts.createdat AS createdat 
       FROM purchasedproducts 
       INNER JOIN products ON purchasedproducts.productid = products.productid
       WHERE purchasedproducts.userid = $1`, // Filtra por el userid del usuario
      [userid] // Pasa el userid como parámetro
    );

    // Respond with the purchased products
    res.status(200).json({
      message: 'Listed purchased products',
      purchasedProducts: purchasedProducts.rows,
    });
  } catch (err: any) {
    console.error('Error occurred while consulting purchased products: ', err.message);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// View product categories
router.get('/products/showCategories', async (req: Request<{}, {}>, res: Response) => {
  try {

    // Query all public product information
    const productCategories = await pool.query(
      'SELECT categoryid, category FROM productcategories'
    );

    // Respond with the created product
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

    // Check if the token exists
    if (!token) {
      res.status(401).json({ message: 'Unauthorized. Token not found' });
      return;
    }

    // Get the userid from the token
    const userid = getUserFromToken(token)?.userid;
    if (!userid) {
      res.status(401).json({ message: 'Unauthorized. Invalid token' });
      return;
    }

    // Get the filter from the request body
    const { filter } = req.body;

    let products;
    if (!filter || filter.trim() === '') {
      // If there is no filter, select 10 random products
      products = await pool.query(`
        SELECT productid, name, price, imageurls 
        FROM products 
        WHERE isactive = TRUE AND userid != $1
        ORDER BY RANDOM()
        LIMIT 10
      `, [userid]);
    } else {
      // If there is a filter, perform the normal search
      products = await pool.query(`
        SELECT productid, name, price, imageurls 
        FROM products 
        WHERE name ILIKE $1 AND isactive = TRUE AND userid != $2
      `, [`%${filter}%`, userid]);
    }

    // Validate if there are no results
    if (products.rows.length === 0) {
      res.status(404).json({ message: "No products found." });
      return;
    }

    // Return the found products
    res.json(products.rows);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).json({ error: "Error searching for products" });
  }
});

export default router;
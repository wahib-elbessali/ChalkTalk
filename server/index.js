require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
//const helmet = require("helmet");
const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const chatRoutes = require("./routes/chatRoutes");
const User = require("./models/User");
const Message = require("./models/Message");
const Conversation = require("./models/Conversation");
const getChatResponse = require("./config/bot");
const http = require("http");
const { Server } = require("socket.io");

// Use environment variables
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const PORT = process.env.PORT || 5000;

// Create the express app and apply security middleware
const app = express();
//app.use(helmet());

// Configure CORS using the client URL
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Connect to MongoDB
connectDB();

// Define API routes
app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);

// Create the HTTP server and initialize socket.io with CORS settings
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    credentials: true,
  },
});

// Socket.io event handling
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // When a user connects, save their socket ID in the database
  socket.on("saveSocketID", async (data) => {
    try {
      await User.findOneAndUpdate({ _id: data.userId }, { socketId: socket.id });
    } catch (err) {
      console.error("Error saving socket ID:", err);
    }
  });

  // Handle sending messages in a conversation
  socket.on("sendMessage", async (message) => {
    const { senderId, conversationId, text } = message;
    try {
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) return;

      const newMessage = new Message({
        sender: senderId,
        message: text,
      });
      const savedMessage = await newMessage.save();

      await Conversation.findByIdAndUpdate(
        conversationId,
        {
          $push: { messages: savedMessage._id },
          lastUpdated: new Date(),
        },
        { new: true }
      );

      const senderUser = await User.findById(senderId, "username");
      if (!senderUser) throw new Error("Sender not found");

      const participants = await User.find({
        _id: { $in: conversation.participants },
      });

      const emittedMessage = await savedMessage.populate("sender", "username");

      // Emit the new message to all participants
      participants.forEach((user) => {
        if (user.socketId) {
          io.to(user.socketId).emit("receiveMessage", {
            message: emittedMessage,
            conversationId,
          });
        }
      });

      // Handle bot interaction if the message starts with "@chatBot"
      if (text.startsWith("@chatBot")) {
        const botMessage = text.replace("@chatBot", "").trim();

        try {
          // Fetch conversation details for subject-specific context
          const conversation = await Conversation.findById(conversationId);
          if (!conversation || !conversation.subject) {
            console.error("Conversation or subject not found.");
            return;
          }

          const subject = conversation.subject;
          // Construct a prompt for the bot with a subject constraint
          const botPrompt = `Answer like you are a "${subject}" bot, so don't answer if the question is about a different field. ${botMessage}`;
          
          // Get the AI response using the secret API key stored in env variables
          const botResponse = await getChatResponse(botPrompt);
          const chatbotId = "67b9be5876dcba6411261d09";

          const botReply = new Message({
            sender: chatbotId,
            message: botResponse,
          });
          const savedBotReply = await botReply.save();

          await Conversation.findByIdAndUpdate(
            conversationId,
            { $push: { messages: savedBotReply._id } },
            { new: true }
          );

          const emittedBotMessage = await savedBotReply.populate("sender", "username");

          participants.forEach((user) => {
            if (user.socketId) {
              io.to(user.socketId).emit("receiveMessage", {
                message: emittedBotMessage,
                conversationId,
              });
            }
          });
        } catch (error) {
          console.error("Error getting bot response:", error);
        }
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  });

  // Create a private conversation if one does not exist, and send the message
  socket.on("createPrivateConversation", async ({ senderId, receiverId, text }) => {
    try {
      let conversation = await Conversation.findOne({
        participants: { $all: [senderId, receiverId] },
        type: "private",
      });

      if (!conversation) {
        conversation = new Conversation({
          participants: [senderId, receiverId],
          messages: [],
          type: "private",
        });
        await conversation.save();
      }

      const newMessage = new Message({
        sender: senderId,
        message: text,
      });
      const savedMessage = await newMessage.save();

      conversation.messages.push(savedMessage._id);
      conversation.lastUpdated = new Date();
      await conversation.save();

      const senderUser = await User.findById(senderId, "username socketId");
      const receiverUser = await User.findById(receiverId, "username socketId");

      if (!senderUser || !receiverUser) throw new Error("User not found");

      const emittedMessage = await savedMessage.populate("sender", "username");

      [senderUser, receiverUser].forEach((user) => {
        if (user.socketId) {
          io.to(user.socketId).emit("receiveMessage", {
            message: emittedMessage,
            conversationId: conversation._id,
          });
        }
      });

      console.log(
        `New conversation created & message sent between ${senderUser.username} and ${receiverUser.username}`
      );
    } catch (error) {
      console.error("Error creating private conversation:", error);
    }
  });

  // Handle creation of a group conversation
  socket.on("createGroupConversation", async ({ name, subject, participants, admin }) => {
    try {
      const newGroup = new Conversation({
        type: "group",
        name,
        subject,
        participants,
        admin,
      });
      await newGroup.save();

      io.emit("groupCreated", newGroup);
    } catch (error) {
      console.error("Error creating group:", error);
    }
  });

  // On disconnect, clear the socketId and update lastDisconnected time
  socket.on("disconnect", async () => {
    try {
      await User.findOneAndUpdate(
        { socketId: socket.id },
        { socketId: null, lastDisconnected: new Date() }
      );
    } catch (err) {
      console.error("Error during disconnect:", err);
    }
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

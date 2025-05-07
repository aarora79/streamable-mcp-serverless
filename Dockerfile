# Use Node.js 18 as the base image for Lambda
FROM public.ecr.aws/lambda/nodejs:18

# Set working directory
WORKDIR ${LAMBDA_TASK_ROOT}

# Copy package files and TypeScript config
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies - including dev dependencies for building
RUN npm install

# Copy source code and tests
COPY src/ ./src/

# Build TypeScript files
RUN npm run build && ls -la dist/

# The Lambda handler
CMD [ "dist/server.handler" ]
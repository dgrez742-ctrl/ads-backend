ARG CACHEBUST=2
FROM node:20-alpine

WORKDIR /app

COPY Package.json ./package.json
RUN npm install

RUN mkdir -p src/routes src/services src/jobs

COPY Index.js ./src/index.js
COPY Supabase.js ./src/supabase.js
COPY Webhooks.js ./src/routes/webhooks.js
COPY Simulator.routes.js ./src/routes/simulator.js
COPY Retell.js ./src/services/retell.js
COPY Twilio.js ./src/services/twilio.js
COPY Leads.js ./src/services/leads.js
COPY Simulator.js ./src/services/simulator.js
COPY FollowUp.js ./src/jobs/followUp.js
COPY Index.html ./Index.html
COPY Simulator.html ./simulator.html

EXPOSE 3000

CMD ["node", "src/index.js"]

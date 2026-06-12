FROM node:18-alpine

WORKDIR /app

COPY Package.json ./package.json
RUN npm install

COPY Index.js ./Index.js
COPY Supabase.js ./Supabase.js
COPY Webhooks.js ./Webhooks.js
COPY Retell.js ./Retell.js
COPY Twilio.js ./Twilio.js
COPY Leads.js ./Leads.js
COPY FollowUp.js ./FollowUp.js
COPY Dashboard.html ./Dashboard.html

RUN mkdir -p src/routes src/services src/jobs && \
    cp Index.js src/index.js && \
    cp Supabase.js src/supabase.js && \
    cp Webhooks.js src/routes/webhooks.js && \
    cp Retell.js src/services/retell.js && \
    cp Twilio.js src/services/twilio.js && \
    cp Leads.js src/services/leads.js && \
    cp FollowUp.js src/jobs/followUp.js

EXPOSE 3000

CMD ["node", "src/index.js"]

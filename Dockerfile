FROM nginx:alpine

COPY rfid_heatmap_mobile_prototype_fixed.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

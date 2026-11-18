// Fixture B: GPIO4 constantly LOW
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
void app_main(void) {
    gpio_reset_pin(GPIO_NUM_4);
    gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_4, 0);
    printf("PLUGAI_FIXTURE gpio4_low\n");
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
}
